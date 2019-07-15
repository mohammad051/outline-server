// Copyright 2018 The Outline Authors
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import * as randomstring from 'randomstring';
import * as uuidv4 from 'uuid/v4';

import {Clock} from '../infrastructure/clock';
import {PortProvider} from '../infrastructure/get_port';
import {JsonConfig} from '../infrastructure/json_config';
import * as logging from '../infrastructure/logging';
import {PrometheusClient} from '../infrastructure/prometheus_scraper';
import {AccessKey, AccessKeyId, AccessKeyMetricsId, AccessKeyQuota, AccessKeyRepository, ProxyParams} from '../model/access_key';
import {ShadowsocksAccessKey, ShadowsocksServer} from '../model/shadowsocks_server';

import {ManagerMetrics} from './manager_metrics';
import {ServerConfigJson} from './server_config';

// The format as json of access keys in the config file.
interface AccessKeyJson {
  id: AccessKeyId;
  metricsId: AccessKeyId;
  name: string;
  password: string;
  port: number;
  encryptionMethod?: string;
  quota?: AccessKeyQuota;
}

// The configuration file format as json.
export interface AccessKeyConfigJson {
  accessKeys?: AccessKeyJson[];
  // Next AccessKeyId to use.
  nextId?: number;

  // DEPRECATED: Use ServerConfigJson.portForNewAccessKeys instead.
  defaultPort?: number;
}

export interface UsageMetrics {
  getOutboundByteTransfer(accessKeyId: string, windowHours: number): Promise<number>;
}

// AccessKey implementation with write access enabled on properties that may change.
class ServerAccessKey implements AccessKey {
  readonly id: AccessKeyId;
  name: string;
  metricsId: AccessKeyMetricsId;
  readonly proxyParams: ProxyParams;
  quota?: AccessKeyQuota;
  isOverQuota?: boolean;
}

// Generates a random password for Shadowsocks access keys.
function generatePassword(): string {
  return randomstring.generate(12);
}

function makeAccessKey(hostname: string, accessKeyJson: AccessKeyJson): AccessKey {
  return {
    id: accessKeyJson.id,
    name: accessKeyJson.name,
    metricsId: accessKeyJson.metricsId,
    proxyParams: {
      hostname,
      portNumber: accessKeyJson.port,
      encryptionMethod: accessKeyJson.encryptionMethod,
      password: accessKeyJson.password,
    },
    quota: accessKeyJson.quota,
    isOverQuota: false
  };
}

function makeAccessKeyJson(accessKey: AccessKey): AccessKeyJson {
  return {
    id: accessKey.id,
    metricsId: accessKey.metricsId,
    name: accessKey.name,
    password: accessKey.proxyParams.password,
    port: accessKey.proxyParams.portNumber,
    encryptionMethod: accessKey.proxyParams.encryptionMethod,
    quota: accessKey.quota
  };
}

// AccessKeyRepository that keeps its state in a config file and uses ShadowsocksServer
// to start and stop per-access-key Shadowsocks instances.
export class ServerAccessKeyRepository implements AccessKeyRepository {
  private static QUOTA_ENFORCEMENT_INTERVAL_MS = 60 * 60 * 1000;  // 1h
  private NEW_USER_ENCRYPTION_METHOD = 'chacha20-ietf-poly1305';
  private accessKeys: ServerAccessKey[];
  private portForNewAccessKeys: number|undefined;

  constructor(
      private portProvider: PortProvider, private proxyHostname: string,
      private keyConfig: JsonConfig<AccessKeyConfigJson>,
      private shadowsocksServer: ShadowsocksServer, private metrics: UsageMetrics) {
    if (this.keyConfig.data().accessKeys === undefined) {
      this.keyConfig.data().accessKeys = [];
    }
    if (this.keyConfig.data().nextId === undefined) {
      this.keyConfig.data().nextId = 0;
    }
    this.accessKeys = this.loadAccessKeys();
  }

  // Starts the Shadowsocks server and exposes the access key configuration to the server.
  // Periodically enforces access key quotas.
  async start(clock: Clock): Promise<void> {
    await this.enforceAccessKeyQuotas();
    await this.updateServer();
    clock.setInterval(async () => {
      try {
        await this.enforceAccessKeyQuotas();
      } catch (e) {
        logging.error(`Failed to enforce access key quotas: ${e}`);
      }
    }, ServerAccessKeyRepository.QUOTA_ENFORCEMENT_INTERVAL_MS);
  }

  enableSinglePort(portForNewAccessKeys: number) {
    this.portForNewAccessKeys = portForNewAccessKeys;
  }

  async createNewAccessKey(): Promise<AccessKey> {
    const port = this.portForNewAccessKeys || await this.portProvider.reserveNewPort();
    const id = this.keyConfig.data().nextId.toString();
    this.keyConfig.data().nextId += 1;
    const metricsId = uuidv4();
    const password = generatePassword();
    const accessKey: AccessKey = {
      id,
      name: '',
      metricsId,
      proxyParams: {
        hostname: this.proxyHostname,
        portNumber: port,
        encryptionMethod: this.NEW_USER_ENCRYPTION_METHOD,
        password,
      },
      quota: undefined,
      isOverQuota: false
    };
    this.accessKeys.push(accessKey);
    this.saveAccessKeys();
    await this.updateServer();
    return accessKey;
  }

  removeAccessKey(id: AccessKeyId): boolean {
    for (let ai = 0; ai < this.accessKeys.length; ai++) {
      const accessKey = this.accessKeys[ai];
      if (accessKey.id === id) {
        this.portProvider.freePort(accessKey.proxyParams.portNumber);
        this.accessKeys.splice(ai, 1);
        this.saveAccessKeys();
        this.updateServer();
        return true;
      }
    }
    return false;
  }

  listAccessKeys(): AccessKey[] {
    return [...this.accessKeys];  // Return a copy to the access key array.
  }

  renameAccessKey(id: AccessKeyId, name: string): boolean {
    const accessKey = this.getAccessKey(id);
    if (!accessKey) {
      return false;
    }
    accessKey.name = name;
    try {
      this.saveAccessKeys();
    } catch (error) {
      return false;
    }
    return true;
  }

  async setAccessKeyQuota(id: AccessKeyId, quota: AccessKeyQuota): Promise<boolean> {
    if (!quota || quota.quotaBytes < 0 || quota.windowHours < 0) {
      return false;
    }
    const accessKey = this.getAccessKey(id);
    if (!accessKey) {
      return false;
    }
    accessKey.quota = quota;
    try {
      this.saveAccessKeys();
      const quotaStautsChanged = await this.updateAccessKeyQuotaStatus(accessKey);
      if (quotaStautsChanged) {
        // Reflect the access key quota status if it changed with the new quota.
        await this.updateServer();
      }
    } catch (error) {
      return false;
    }
    return true;
  }

  async removeAccessKeyQuota(id: AccessKeyId): Promise<boolean> {
    const accessKey = this.getAccessKey(id);
    if (!accessKey) {
      return false;
    }
    const wasOverQuota = accessKey.isOverQuota;
    accessKey.quota = undefined;
    accessKey.isOverQuota = false;
    try {
      this.saveAccessKeys();
      if (wasOverQuota) {
        await this.updateServer();
      }
    } catch (error) {
      return false;
    }
    return true;
  }

  getMetricsId(id: AccessKeyId): AccessKeyMetricsId|undefined {
    const accessKey = this.getAccessKey(id);
    return accessKey ? accessKey.metricsId : undefined;
  }

  // Compares access key usage with collected metrics, marking them as under or over quota.
  async enforceAccessKeyQuotas() {
    let quotaStatusChanged = false;
    for (const accessKey of this.accessKeys) {
      quotaStatusChanged = quotaStatusChanged || await this.updateAccessKeyQuotaStatus(accessKey);
    }
    if (quotaStatusChanged) {
      this.updateServer();
    }
  }

  // Updates `accessKey` quota status by comparing its usage with collected metrics. Returns whether
  // the quota status changed.
  private async updateAccessKeyQuotaStatus(accessKey: ServerAccessKey): Promise<boolean> {
    if (!accessKey.quota) {
      return false;  // Don't query the usage of access keys without quota.
    }
    const usageBytes =
        await this.metrics.getOutboundByteTransfer(accessKey.id, accessKey.quota.windowHours);
    const isOverQuota = usageBytes > accessKey.quota.quotaBytes;
    logging.debug(`Enforcing quota for access key ${accessKey.id}. Quota: ${
        JSON.stringify(accessKey.quota)}, usage: ${usageBytes}B, isOverQuota: ${isOverQuota}`);
    const quotaStatusChanged = isOverQuota !== accessKey.isOverQuota;
    accessKey.isOverQuota = isOverQuota;
    return quotaStatusChanged;
  }

  private updateServer(): Promise<void> {
    const serverAccessKeys = this.accessKeys.filter(key => !key.isOverQuota).map(key => {
      return {
        id: key.id,
        port: key.proxyParams.portNumber,
        cipher: key.proxyParams.encryptionMethod,
        secret: key.proxyParams.password
      };
    });
    return this.shadowsocksServer.update(serverAccessKeys);
  }

  private loadAccessKeys(): AccessKey[] {
    return this.keyConfig.data().accessKeys.map(key => makeAccessKey(this.proxyHostname, key));
  }

  private saveAccessKeys() {
    try {
      this.keyConfig.data().accessKeys = this.accessKeys.map(key => makeAccessKeyJson(key));
      this.keyConfig.write();
    } catch (error) {
      throw new Error(`Failed to save access key config: ${error}`);
    }
  }

  // Returns a reference to the access key with `id`, or undefined if the key is not found.
  private getAccessKey(id: AccessKeyId): ServerAccessKey|undefined {
    for (const accessKey of this.accessKeys) {
      if (accessKey.id === id) {
        return accessKey;
      }
    }
    return undefined;
  }
}

// Retrieves access key usage metrics from a Prometheus instance.
export class AccessKeyUsageMetrics implements UsageMetrics {
  constructor(private prometheusClient: PrometheusClient) {}

  async getOutboundByteTransfer(accessKeyId: string, windowHours: number): Promise<number> {
    let bytesTransferred = 0;
    const result = await this.prometheusClient.query(
        `sum(increase(shadowsocks_data_bytes{dir=~"c<p|p>t",access_key="${accessKeyId}"}[${
            windowHours}h])) by (access_key)`);
    if (result && result.result[0] && result.result[0].metric['access_key'] === accessKeyId) {
      bytesTransferred = Math.round(parseFloat(result.result[0].value[1]));
    }
    return bytesTransferred;
  }
}
