// Collects every sentence «سباق الكلمات» can speak, so it can be recorded once
// with a clear voice (see tools/voice-make.js). Run: node tools/voice-collect.js
const fs=require('fs'),path=require('path');
const ROOT=path.join(__dirname,'..');
const html=fs.readFileSync(path.join(ROOT,'bike.html'),'utf8');
const data=html.slice(html.indexOf('/* ---------------- Data'),html.indexOf('/* ---------------- Sound'));
const shared=fs.readFileSync(path.join(__dirname,'voice-key.js'),'utf8');
const set=new Map();let STAGE=0;
const add=t=>String(t||'').split('|').forEach(x=>{x=normVoice(x);if(x&&!set.has(x))set.set(x,STAGE)});
const ctx={add,setStage:n=>{STAGE=n},localStorage:{getItem:()=>null,setItem(){}},console};
const fn=new Function('ctx',`with(ctx){${shared}\n${data}
 const TIP={lam:'انظر إلى الحرف الذي بعد اللام',ta:'قف على آخر الكلمة: هل تسمع هاءً أم تاءً؟',forms:'هل الحرف متصل بما قبله وما بعده؟',madd:'اسمع الصوت: هل هو ممدود؟'};
 ctx.normVoice=normVoice;
 STAGES.forEach(st=>add(st.intro[3]));
 ['أحسنت!','حاول مرة أخرى'].concat(Object.values(TIP)).forEach(add);
 STAGES.forEach((st,si)=>{ctx.setStage(si+1);for(let r=0;r<4000;r++)st.make().forEach(q=>{
  add(q.qsay);add(q.rsay);add('حاول مرة أخرى|'+(TIP[q.type]||''));
  if(q.type==='build'){add(q.word+'|الحرفُ التالي');q.w.forEach(c=>add(nm(c)))}
 })});
}`);
// normVoice must exist before the data runs
eval(shared);ctx.normVoice=normVoice;global.normVoice=normVoice;
fn(ctx);
['أحسنت! نتوقف عند الإشارة الحمراء','أخضر، انطلق','انتبه! الإشارة حمراء، اضغط قِف','تذكّر: عند الإشارة الحمراء نقف','حاولوا مرة أخرى معاً',
 'أحسنتم يا أبطال! أكملتم الطريق معاً','أحسنت يا بطل! أكملت الطريق'].forEach(add);
ctx.setStage(0);
const list=[...set].map(([t,st])=>({h:voiceKey(t),t,st}));
fs.mkdirSync(path.join(ROOT,'voice'),{recursive:true});
fs.writeFileSync(path.join(ROOT,'voice','phrases.json'),JSON.stringify(list,null,0).replace(/},{/g,'},\n{'));
console.log(list.length,'phrases');
