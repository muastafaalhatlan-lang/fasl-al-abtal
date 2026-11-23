// Records the sentences of «سباق الكلمات» with Gemini's text-to-speech, once, into voice/<key>.mp3.
// The game plays these files; any sentence without a file falls back to the device voice.
//
//   1) node tools/voice-collect.js          (list every sentence -> voice/phrases.json)
//   2) GEMINI_API_KEY=... node tools/voice-make.js [--voice Kore] [--batch 10] [--limit 50]
//
// Safe to re-run: sentences that already have a file are skipped, so a run stopped by the
// free-tier daily limit continues where it left off. Needs curl and ffmpeg.
const fs=require('fs'),path=require('path'),os=require('os'),{execFileSync,spawnSync}=require('child_process');
const ROOT=path.join(__dirname,'..'),OUT=path.join(ROOT,'voice');
eval(fs.readFileSync(path.join(__dirname,'voice-key.js'),'utf8'));
const arg=(n,d)=>{const i=process.argv.indexOf('--'+n);return i>0?process.argv[i+1]:d};
const VOICE_NAME=arg('voice','Kore'),BATCH=+arg('batch',10),LIMIT=+arg('limit',1e9);
const KEY=process.env.GEMINI_API_KEY||'proxy-injected'; // in a cloud session the network proxy adds the real key
const API='https://generativelanguage.googleapis.com/v1beta';
const STYLE='Read the following Modern Standard Arabic aloud, slowly and very clearly, with full and correct pronunciation of every vowel mark, in the warm voice of a kind teacher speaking to six-year-old children.';
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
  tts.sort((a,b)=>(/pro/.test(b)-/pro/.test(a))||b.localeCompare(a)); // prefer pro, then the newest name
  return tts[0];
}
async function speak(model,text){
  for(let attempt=0;attempt<6;attempt++){
    const r=curl(`${API}/models/${model}:generateContent`,{contents:[{parts:[{text}]}],
      generationConfig:{responseModalities:['AUDIO'],speechConfig:{voiceConfig:{prebuiltVoiceConfig:{voiceName:VOICE_NAME}}}}});
    if(r.error){
      const retry=(r.error.details||[]).find(d=>d.retryDelay);const wait=retry?parseFloat(retry.retryDelay)*1000:20000*(attempt+1);
      if(r.error.code===429&&/per.?day|daily|PerDay/i.test(JSON.stringify(r.error)))throw Object.assign(new Error('daily limit reached'),{daily:true});
      if(r.error.code===429||r.error.code>=500){console.log(`  waiting ${Math.round(wait/1000)}s (${r.error.status||r.error.code})`);await sleep(wait+1000);continue}
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
  const log=String(spawnSync('ffmpeg',['-hide_banner','-f','s16le','-ar',String(rate),'-ac','1','-i',pcmFile,'-af','silencedetect=noise=-40dB:d=0.55','-f','null','-'],{maxBuffer:64<<20}).stderr||'');
  const total=fs.statSync(pcmFile).size/2/rate;
  const sil=[];let st=null;for(const l of log.split('\n')){const a=l.match(/silence_start: ([\d.]+)/),b=l.match(/silence_end: ([\d.]+)/);if(a)st=+a[1];if(b&&st!=null){sil.push([st,+b[1]]);st=null}}
  if(st!=null)sil.push([st,total]);
  const segs=[];let cur=0;for(const [a,b] of sil){if(a-cur>0.15)segs.push([Math.max(0,cur-0.05),a+0.05]);cur=b}
  if(total-cur>0.15)segs.push([Math.max(0,cur-0.05),total]);
  return segs.length===n?segs:null;
}
(async()=>{
  const list=JSON.parse(fs.readFileSync(path.join(OUT,'phrases.json'),'utf8'));
  const todo=list.filter(p=>!fs.existsSync(path.join(OUT,p.h+'.mp3'))).slice(0,LIMIT);
  console.log(`${list.length} sentences, ${todo.length} to record`);
  const model=todo.length?pickModel():'';if(model)console.log('model:',model,'voice:',VOICE_NAME);
  let done=0;
  try{
    for(let i=0;i<todo.length;){
      const group=todo.slice(i,i+BATCH);let ok=false;
      if(group.length>1){ // several sentences in one request, separated by long pauses, then cut apart
        const text=STYLE+' Read each line on its own, and leave a clear pause of two seconds after every line.\n\n'+group.map(p=>p.t).join('\n');
        const {pcm,rate}=await speak(model,text);const f=path.join(TMP,'b.pcm');fs.writeFileSync(f,pcm);
        const segs=splitByPauses(f,rate,group.length);
        if(segs){group.forEach((p,k)=>encode(f,rate,segs[k][0],segs[k][1],path.join(OUT,p.h+'.mp3')));ok=true}
        else console.log(`  batch at ${i} did not split cleanly, recording one by one`);
      }
      if(!ok)for(const p of group){const {pcm,rate}=await speak(model,STYLE+'\n\n'+p.t);const f=path.join(TMP,'s.pcm');fs.writeFileSync(f,pcm);encode(f,rate,null,null,path.join(OUT,p.h+'.mp3'))}
      i+=group.length;done+=group.length;console.log(`  ${done}/${todo.length}`);
    }
  }catch(e){console.log(e.daily?'Stopped: the daily free limit was reached. Run again tomorrow to continue.':'Stopped: '+e.message)}
  const have=list.filter(p=>fs.existsSync(path.join(OUT,p.h+'.mp3'))).map(p=>p.h);
  fs.writeFileSync(path.join(OUT,'list.json'),JSON.stringify(have));
  console.log(`voice/list.json: ${have.length}/${list.length} sentences have a recorded voice`);
})();
