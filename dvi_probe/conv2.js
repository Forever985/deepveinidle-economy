const fs=require('fs');
const src=fs.readFileSync('monsters_raw.txt','utf8');
const arr=new Function('return '+src+';')();
fs.writeFileSync('monsters.json',JSON.stringify(arr,null,1));
console.log('monsters:',arr.length);
console.log('sample:',JSON.stringify(arr[0]));
console.log('last:',JSON.stringify(arr[arr.length-1]));
