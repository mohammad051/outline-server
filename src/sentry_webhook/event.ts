/**
 * Copyright 2024 The Outline Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import type {SentryEvent as SentryEventBase} from '@sentry/types';

// Although SentryEvent.tags is declared as an index signature object, it is actually an array of
// arrays i.e. [['key0', 'value0'], ['key1', 'value1']].
export type Tags = null | [string, string][];

export interface SentryEvent extends Omit<SentryEventBase, 'tags'> {
  tags?: Tags | null;
}
