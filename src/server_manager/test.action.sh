#!/bin/bash -eu
#
# Copyright 2018 The Outline Authors
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#      http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

readonly TEST_DIR="${BUILD_DIR}/js/server_manager/"
rm -rf "${TEST_DIR}"

npm run action server_manager/web_app/build_install_script

# Use commonjs modules, jasmine runs in node.
tsc -p "${ROOT_DIR}/src/server_manager" --outDir "${TEST_DIR}" --module commonjs

export NODE_OPTIONS=--openssl-legacy-provider
jasmine --config="${ROOT_DIR}/jasmine.json"

npm run action server_manager/web_app/test

rm -rf "${TEST_DIR}"
