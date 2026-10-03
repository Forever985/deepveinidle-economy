const fs=require('fs');
const $o=[];
const Pc=(o)=>({itemId:70,chanceAtReq:0.3,safeAtLevel:o+25});
for (const [inF,outF] of [["items_raw.txt","items.json"],["actions_raw.txt","actions.json"]]) {
  const src=fs.readFileSync(inF,'utf8');
  const arr=new Function('$o','Pc','return '+src+';')($o,Pc);
  fs.writeFileSync(outF,JSON.stringify(arr,null,1));
  console.log(inF,'->',outF,'records:',arr.length);
}
