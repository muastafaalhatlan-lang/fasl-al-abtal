// Records the sentences of «سباق الكلمات» with Gemini's text-to-speech, once, into voice/<key>.mp3.
// The game plays these files; any sentence without a file falls back to the device voice.
//
//   1) node tools/voice-collect.js          (list every sentence -> voice/phrases.json)
//   2) GEMINI_API_KEY=... node tools/voice-make.js [--voice Kore] [--batch 10] [--limit 50]
//   3) GEMINI_API_KEY=... node tools/voice-make.js --check   (Gemini listens to every clip; wrong ones are deleted, run step 2 again)
//
// Safe to re-run: sentences that already have a file are skipped, so a run stopped by the
// free-tier daily limit continues where it left off. Needs curl and ffmpeg.
const fs=require('fs'),path=require('path'),os=require('os'),{execFileSync,spawnSync}=require('child_process');
const ROOT=path.join(__dirname,'..');
eval(fs.readFileSync(path.join(__dirname,'voice-key.js'),'utf8'));
const arg=(n,d)=>{const i=process.argv.indexOf('--'+n);return i>0?process.argv[i+1]:d};
const VOICE_NAME=arg('voice','Kore'),BATCH=+arg('batch',10),LIMIT=+arg('limit',1e9);
const OUT=path.resolve(arg('out',path.join(ROOT,'voice'))),PHRASES=path.resolve(arg('in',path.join(ROOT,'voice','phrases.json')));
const KEY=process.env.GEMINI_API_KEY||'proxy-injected'; // in a cloud session the network proxy adds the real key
const API='https://generativelanguage.googleapis.com/v1beta';
// No reading instructions: the TTS model reads them aloud. Plain text only.
const TMP=fs.mkdtempSync(path.join(os.tmpdir(),'voice-'));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

function curl(url,body){
  const args=['-sS','--max-time','180','-H','Content-Type: application/json','-H','x-goog-api-key: '+KEY];
  if(body){fs.writeFileSync(path.join(TMP,'req.json'),JSON.stringify(body));args.push('--data-binary','@'+path.join(TMP,'req.json'))}
  const out=execFileSync('curl',[...args,url],{maxBuffer:256<<20}).toString();
  try{return JSON.parse(out)}catch(e){throw new Error('bad response: '+out.slice(0,300))}
}
function pickModel(){
  const forced=arg('model');if(forced)return forced;
  const r=curl(API+'/models?pageSize=200');if(r.error)throw new Error(r.error.message);
  const tts=(r.models||[]).map(m=>m.name.replace(/^models\//,'')).filter(n=>/tts/i.test(n));
  if(!tts.length)throw new Error('no text-to-speech model is available for this key');
  const ver=n=>+((n.match(/gemini-(\d+(?:\.\d+)?)/)||[0,0])[1]);
  tts.sort((a,b)=>ver(b)-ver(a)||(/lite/.test(a)-/lite/.test(b))||(/preview/.test(a)-/preview/.test(b))); // newest, full, stable first
  return tts[0];
}
async function speak(model,text){
  for(let attempt=0;attempt<10;attempt++){
    const r=curl(`${API}/models/${model}:generateContent`,{contents:[{parts:[{text}]}],
      generationConfig:{responseModalities:['AUDIO'],speechConfig:{voiceConfig:{prebuiltVoiceConfig:{voiceName:VOICE_NAME}}}}});
    if(r.error){
      const retry=(r.error.details||[]).find(d=>d.retryDelay);const wait=retry?parseFloat(retry.retryDelay)*1000:20000*(attempt+1);
      const ids=(r.error.details||[]).flatMap(d=>(d.violations||[]).map(v=>v.quotaId)).filter(Boolean);
      if(r.error.code===429&&ids.length&&ids.every(q=>/PerDay/i.test(q)))throw Object.assign(new Error('daily limit reached'),{daily:true});
      if(r.error.code===429||r.error.code>=500){console.log(`  waiting ${Math.round(wait/1000)}s (${r.error.status||r.error.code}${ids.length?' '+ids.join(','):''})`);await sleep(wait+1000);continue}
      throw new Error(r.error.message);
    }
    const part=(r.candidates?.[0]?.content?.parts||[]).find(p=>p.inlineData);
    if(!part)throw new Error('no audio in response');
    const rate=+((part.inlineData.mimeType||'').match(/rate=(\d+)/)||[0,24000])[1];
    return {pcm:Buffer.from(part.inlineData.data,'base64'),rate};
  }
  throw new Error('too many retries');
}
function ff(args){return execFileSync('ffmpeg',['-hide_banner','-loglevel','error','-y',...args],{maxBuffer:64<<20}).toString()}
function encode(pcmFile,rate,from,to,out){
  ff(['-f','s16le','-ar',String(rate),'-ac','1','-i',pcmFile,...(from!=null?['-ss',String(from),'-to',String(to)]:[]),
      '-af','silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.05,areverse,silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.08,areverse,loudnorm=I=-16:TP=-1.5',
      '-ac','1','-ar','24000','-b:a','40k',out]);
}
function splitByPauses(pcmFile,rate,n){
  const log=String(spawnSync('ffmpeg',['-hide_banner','-f','s16le','-ar',String(rate),'-ac','1','-i',pcmFile,'-af','silencedetect=noise=-40dB:d=0.45','-f','null','-'],{maxBuffer:64<<20}).stderr||'');
  const total=fs.statSync(pcmFile).size/2/rate;
  const sil=[];let st=null;for(const l of log.split('\n')){const a=l.match(/silence_start: ([\d.]+)/),b=l.match(/silence_end: ([\d.]+)/);if(a)st=+a[1];if(b&&st!=null){sil.push([st,+b[1]]);st=null}}
  if(st!=null)sil.push([st,total]);
  const segs=[];let cur=0;for(const [a,b] of sil){if(a-cur>0.15)segs.push([Math.max(0,cur-0.05),a+0.05]);cur=b}
  if(total-cur>0.15)segs.push([Math.max(0,cur-0.05),total]);
  return segs.length===n?segs:null;
}
// ---- --check: let Gemini listen to each clip and compare with the sentence (letters only)
const bare=t=>t.replace(/[\u064B-\u0652\u0640]/g,'').replace(/[أإآ]/g,'ا').replace(/ة/g,'ه').replace(/ى/g,'ي').replace(/[^\u0621-\u064A]/g,'');
function lev(a,b){const d=Array.from({length:a.length+1},(_,i)=>[i]);for(let j=1;j<=b.length;j++)d[0][j]=j;
  for(let i=1;i<=a.length;i++)for(let j=1;j<=b.length;j++)d[i][j]=Math.min(d[i-1][j]+1,d[i][j-1]+1,d[i-1][j-1]+(a[i-1]===b[j-1]?0:1));return d[a.length][b.length]}
async function check(list){
  const m=arg('check-model','gemini-3.8-flash');let bad=0,n=0;
  for(const p of list){const f=path.join(OUT,p.h+'.mp3');if(!fs.existsSync(f))continue;n++;
    let heard='';for(let a=0;a<6;a++){const r=curl(`${API}/models/${m}:generateContent`,{contents:[{parts:[{inlineData:{mimeType:'audio/mp3',data:fs.readFileSync(f).toString('base64')}},{text:'Transcribe this Arabic audio exactly. Output only the words you hear.'}]}]});
      if(r.error){if(r.error.code===429||r.error.code>=500){await sleep(15000*(a+1));continue}throw new Error(r.error.message)}
      heard=(r.candidates?.[0]?.content?.parts||[]).map(x=>x.text||'').join(' ').trim();break}
    const A=bare(p.t),B=bare(heard),sim=1-lev(A,B)/Math.max(A.length,B.length,1);
    if(process.argv.includes("--verbose"))console.log(`  ${sim>=0.7?"✓":"✗"} «${p.t}» → «${heard}»`);
    if(sim<0.7){bad++;fs.unlinkSync(f);console.log(`  ✗ «${p.t}» heard «${heard}» -> deleted`)}
  }
  console.log(`checked ${n} clips, ${bad} deleted for re-recording`);
}
(async()=>{
  if(process.argv.includes('--check')){const list=JSON.parse(fs.readFileSync(PHRASES,'utf8'));await check(list);
    fs.writeFileSync(path.join(OUT,'list.json'),JSON.stringify(list.filter(p=>fs.existsSync(path.join(OUT,p.h+'.mp3'))).map(p=>p.h)));return}
  const list=JSON.parse(fs.readFileSync(PHRASES,'utf8'));
  const todo=list.filter(p=>!fs.existsSync(path.join(OUT,p.h+'.mp3'))).slice(0,LIMIT);
  console.log(`${list.length} sentences, ${todo.length} to record`);
  const model=todo.length?pickModel():'';if(model)console.log('model:',model,'voice:',VOICE_NAME);
  let done=0;
  try{
    for(let i=0;i<todo.length;){
      const short=p=>p.t.length<=32&&!/[،.:؟?!,]\s*\S/.test(p.t);
      const group=short(todo[i])?todo.slice(i,i+BATCH).filter((p,k,a)=>a.slice(0,k+1).every(short)):[todo[i]];let ok=false;
      if(group.length>1){ // several short sentences in one request; the model pauses between lines, then we cut them apart
        const text=group.map(p=>p.t+' ...').join('\n\n');
        const {pcm,rate}=await speak(model,text);const f=path.join(TMP,'b.pcm');fs.writeFileSync(f,pcm);
        const segs=splitByPauses(f,rate,group.length);
        if(segs){group.forEach((p,k)=>encode(f,rate,segs[k][0],segs[k][1],path.join(OUT,p.h+'.mp3')));ok=true}
        else console.log(`  batch at ${i} did not split cleanly, recording one by one`);
      }
      if(!ok)for(const p of group){const {pcm,rate}=await speak(model,p.t);const f=path.join(TMP,'s.pcm');fs.writeFileSync(f,pcm);encode(f,rate,null,null,path.join(OUT,p.h+'.mp3'))}
      i+=group.length;done+=group.length;console.log(`  ${done}/${todo.length}`);
    }
  }catch(e){console.log(e.daily?'Stopped: the daily free limit was reached. Run again tomorrow to continue.':'Stopped: '+e.message)}
  const have=list.filter(p=>fs.existsSync(path.join(OUT,p.h+'.mp3'))).map(p=>p.h);
  fs.writeFileSync(path.join(OUT,'list.json'),JSON.stringify(have));
  console.log(`voice/list.json: ${have.length}/${list.length} sentences have a recorded voice`);
})();
