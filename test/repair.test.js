const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const CSV = require('../lib/csv');
const Ledger = require('../lib/ledger');
const Store = require('../lib/store');
const Sync = require('../lib/sync');
const Dataset = require('../lib/dataset');
const vm = require('node:vm');
const browser = vm.createContext({console, Intl, Date, Map, Set, BigInt});
for (const name of ['money','provenance','csv','taxonomy','ledger','preview','profit','dataset']) {
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../lib',name+'.js'),'utf8'),browser);
}

function fixture(currency, market, date, sales) {
  const row = Object.fromEntries(CSV.PAYMENTS_COLUMNS.map(k => [k, '0']));
  Object.assign(row, {'date/time': date, type: 'Order', 'order id': 'SYNTHETIC-ONLY',
    sku: 'AUDIT-FIXTURE', description: 'Synthetic audit fixture - not financial data',
    marketplace: market, 'account type': 'Standard Orders', quantity: '1',
    'product sales': String(sales), 'selling fees': '-1', total: String(sales - 1),
    'Transaction Status': 'Released', 'Transaction Release Date': date});
  const quote = x => '"' + String(x).replaceAll('"', '""') + '"';
  return '"All amounts in ' + currency + ', unless specified"\n' + CSV.PAYMENTS_COLUMNS.map(quote).join(',') + '\n'
    + CSV.PAYMENTS_COLUMNS.map(k => quote(row[k])).join(',') + '\n';
}
const usd = fixture('USD', 'amazon.com', 'Sep 1, 2026 12:00:00 PM PDT', 10);
const cad = fixture('CAD', 'amazon.ca', 'Sep 2, 2026 12:00:00 PM PDT', 20);
const ledger = Ledger.create(10);
Ledger.importText(ledger, usd, {name: 'synthetic-usd.csv'});
Ledger.importText(ledger, cad, {name: 'synthetic-cad.csv'});
assert.equal(ledger.summary({currency:'USD'}).netRevenue, 1000);
assert.equal(ledger.summary({currency:'CAD'}).netRevenue, 2000);
assert.equal(ledger.summary({currency:'EUR'}).rows, 0);
assert.equal(ledger.summary({marketplace:'amazon.ca'}).rows, 1);
assert.equal(ledger.summary({from:'2026-09-02',to:'2026-09-02'}).rows, 1);
assert.equal(Dataset.build({ledger,filter:{currency:'USD'}}).actual.rowCount, 1);
assert.equal(Dataset.build({ledger,filter:{currency:'EUR'}}).actual.present, false);
assert.equal(browser.Dataset.build({ledger,filter:{currency:'USD'}}).actual.rowCount, 1);
const backup = JSON.parse(JSON.stringify(Store.exportBackup({ledger, imports:ledger.imports.map((r,i)=>({id:String(r.importId),name:r.name,family:'Payments transactions',currency:i?'CAD':'USD',marketplace:i?'amazon.ca':'amazon.com',rowCount:r.rowCount})), openingBankCash:1234})));
const restored = Store.deserialiseLedger(Sync.decode(backup.ledger), Ledger);
assert.equal(restored.rowCount, 2);
assert.equal(restored.summary({currency:'CAD'}).netRevenue, 2000);
assert.equal(backup.openingBankCash, 1234);
assert.equal(backup.version, 2);
const p1={currency:'USD',store:'US', period:{start:'2026-09-01',end:'2026-09-30'},rows:[],name:'usd'};
const p2={...p1,currency:'CAD',store:'CA',name:'cad'};
assert.equal(Dataset.build({previews:[p1,p2]}).forecast.present, false);
assert.equal(Dataset.build({previews:[p1,p2],filter:{currency:'USD'}}).forecast.currency, 'USD');
fs.writeFileSync(path.join(__dirname,'synthetic-payments.csv'),usd);
fs.writeFileSync(path.join(__dirname,'synthetic-backup.json'),JSON.stringify(backup));
console.log('passed 14   failed 0   not tested 0');
