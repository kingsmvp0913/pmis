const ft=require('./server/parsers/filetypes');
const {isCategoryRow}=require('./server/daily-log-validate');
(async()=>{
const jobs=[
 ['有謙營造有限公司','C:/Users/kings/OneDrive/Desktop/0817/0817施工日誌辨識問題/07施工日誌-雲林縣元長國小(1).xlsx'],
 ['禾結土木包工業','C:/Users/kings/OneDrive/Desktop/0817/0817施工日誌辨識問題/明禮7.1-7.30.pdf'],
 ['玉森土木包工業','C:/Users/kings/OneDrive/Desktop/0817/0817施工日誌辨識問題/鹿場國小公共工程施工日誌第二聯7月.xls'],
];
for(const [k,f] of jobs){
  const mod=require(`C:/pmis/data/vendor-parsers/${k}.pmisparser.js`);
  const days=await mod.parseAll(f,{filetypes:ft});
  const last=days[days.length-1];
  const rows=(last.dailyRows||[]).filter(r=>!isCategoryRow(r));
  console.log(`\n### ${k} / ${f.split('/').pop()}`);
  console.log(`  ${days.length} 天 ${days[0].header.填報日期} ~ ${last.header.填報日期}`);
  console.log(`  最後一天明細 ${rows.length} 列,項次: ${rows.map(r=>r.項次).join(',')}`);
  console.log(`  本日累計金額=${last.header.本日累計金額}  各項累計金額總和=${rows.reduce((s,r)=>s+(r.累計完成數量||0)*(r.契約單價||0),0).toFixed(2)}`);
}
})();
