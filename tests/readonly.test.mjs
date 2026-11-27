import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

const source = name => readFileSync(new URL('../extension/'+name,import.meta.url),'utf8');

test('安裝包的權限只含側欄、本機偏好與唯一 HTTPS 訂版站', () => {
  const manifest=JSON.parse(source('manifest.json'));
  assert.equal(manifest.manifest_version,3);
  assert.deepEqual(manifest.permissions.sort(),['sidePanel','storage']);
  assert.deepEqual(manifest.host_permissions,['https://ad-pro.cwg.tw/*']);
  assert.deepEqual(manifest.content_scripts.map(script=>script.matches),[manifest.host_permissions]);
  assert.match(manifest.content_security_policy.extension_pages,/connect-src 'none'/);
});

test('訂單分頁拒絕寫入以及庫存頁專屬指令，不碰原單表單',async () => {
  let receiver;
  const writes=[];
  const chrome={runtime:{id:'test-runtime',onMessage:{addListener:fn=>{receiver=fn;}}}};
  runInNewContext(source('reader.js'),{chrome,location:{origin:'https://ad-pro.cwg.tw',pathname:'/orders/901'},
    document:new Proxy({}, {get(_,key){writes.push(String(key));throw Error('Unexpected order-page access');}})});
  const sender={id:'test-runtime'};
  for (const action of ['save','submit','book','applyCue','updateOrder']) {
    assert.equal(receiver({action},sender,()=>assert.fail('Unexpected write response')),undefined);
  }
  for (const action of ['readRates','readSocialRates','readGrid']) {
    const reply=await new Promise(resolve=>receiver({action},sender,resolve));
    assert.match(reply.error,/頁面與查詢項目不符/);
  }
  assert.deepEqual(writes,[]);
});
