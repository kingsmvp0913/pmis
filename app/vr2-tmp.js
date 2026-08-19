const ft=require('./server/parsers/filetypes');
const {isCategoryRow}=require('./server/daily-log-validate');
(async()=>{
const mod=require('C:/pmis/data/vendor-parsers/有謙營造有限公司.pmisparser.js');
const days=await mod.parseAll('C:/Users/kings/OneDrive/Desktop/0817/0817施工日誌辨識問題/07施工日誌-雲林縣元長國小(1).xlsx',{filetypes:ft});
for(const d of days){
  const rows=(d.dailyRows||[]).filter(r=>!isCategoryRow(r));
  console.log(`${d.header.填報日期} ${rows.length} 列  項次尾: ${rows.slice(-6).map(r=>r.項次).join(',')}`);
}
const m=require('C:/pmis/data/vendor-parsers/禾結土木包工業.pmisparser.js');
const md=await m.parseAll('C:/Users/kings/OneDrive/Desktop/0817/0817施工日誌辨識問題/明禮7.1-7.30.pdf',{filetypes:ft});
console.log('\n明禮 B4 檢查:');
for(const d of md.slice(0,4)){
  const rows=(d.dailyRows||[]).filter(r=>!isCategoryRow(r));
  const sum=rows.reduce((s,r)=>s+(r.累計完成數量||0)*(r.契約單價||0),0);
  console.log(`  ${d.header.填報日期} header本日累計金額=${d.header.本日累計金額} 各項累計金額總和=${sum.toFixed(2)}`);
}
})();
