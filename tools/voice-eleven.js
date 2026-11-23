// Records the sentences of «سباق الكلمات» with ElevenLabs text-to-speech into voice/<key>.mp3
// (same files the game plays; see tools/voice-make.js for the Gemini version).
//
//   ELEVEN_API_KEY=... node tools/voice-eleven.js --list                 (Arabic-capable voices in the account)
//   ELEVEN_API_KEY=... node tools/voice-eleven.js --sample id1,id2,...   (one short sample per voice -> voice-samples/)
//   ELEVEN_API_KEY=... node tools/voice-eleven.js --voice <id> [--all]   (record; --all re-records clips made with another voice)
//
// The whole game is about 7,000 characters. Needs curl and ffmpeg.
const fs=require('fs'),path=require('path'),os=require('os'),{execFileSync}=require('child_process');
const ROOT=path.join(__dirname,'..'),OUT=path.join(ROOT,'voice');
const arg=(n,d)=>{const i=process.argv.indexOf('--'+n);return i>0?process.argv[i+1]:d};
const KEY=process.env.ELEVEN_API_KEY||'proxy-injected';
const API='https://api.elevenlabs.io/v1';
const MODEL=arg('model','eleven_multilingual_v2');
const TMP=fs.mkdtempSync(path.join(os.tmpdir(),'eleven-'));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

function curl(method,url,body,outFile){
  const args=['-sS','--max-time','120','-X',method,'-H','xi-api-key: '+KEY,'-H','Content-Type: application/json','-w','\n%{http_code}'];
  if(body){fs.writeFileSync(path.join(TMP,'req.json'),JSON.stringify(body));args.push('--data-binary','@'+path.join(TMP,'req.json'))}
  if(outFile)args.push('-o',outFile);
  const out=execFileSync('curl',[...args,url],{maxBuffer:64<<20}).toString();
  const code=+out.trim().split('\n').pop();
  const text=outFile?'':out.slice(0,out.lastIndexOf('\n'));
  return {code,text};
}
function ff(args){execFileSync('ffmpeg',['-hide_banner','-loglevel','error','-y',...args])}
async function speak(voice,text,out){
  for(let a=0;a<6;a++){
    const raw=path.join(TMP,'raw.mp3');
    const r=curl('POST',`${API}/text-to-speech/${voice}?output_format=mp3_44100_64`,
      {text,model_id:MODEL,voice_settings:{stability:0.6,similarity_boost:0.8,style:0.15,use_speaker_boost:true,speed:0.9}},raw);
    if(r.code===200){ // trim silence, even loudness, small mono mp3
      ff(['-i',raw,'-af','silenceremove=start_periods=1:start_threshold=-45dB,areverse,silenceremove=start_periods=1:start_threshold=-45dB,areverse,loudnorm=I=-16:TP=-1.5','-ac','1','-ar','24000','-b:a','40k',out]);return}
    const msg=fs.existsSync(raw)?fs.readFileSync(raw,'utf8').slice(0,300):'';
    if(r.code===429||r.code>=500){console.log(`  waiting (${r.code})`);await sleep(5000*(a+1));continue}
    throw new Error(`HTTP ${r.code}: ${msg}`);
  }
  throw new Error('too many retries');
}
(async()=>{
  if(process.argv.includes('--list')){
    const r=curl('GET',`${API}/voices`);if(r.code!==200)throw new Error(r.text.slice(0,300));
    for(const v of JSON.parse(r.text).voices){const l=v.labels||{};console.log(`${v.voice_id}  ${v.name}  ${l.gender||''} ${l.age||''} ${l.accent||''} ${l.language||''} ${l.description||l.descriptive||''}`)}
    const u=curl('GET',`${API}/user/subscription`);if(u.code===200){const s=JSON.parse(u.text);console.log(`characters used ${s.character_count}/${s.character_limit} (${s.tier})`)}
    return}
  const sample=arg('sample');
  if(sample){const dir=path.join(ROOT,'voice-samples');fs.mkdirSync(dir,{recursive:true});
    const text='أحسنت! مِفْتَاح، عُصْفُور. اقرأ الكلمةَ واختر صورتها. التنوينُ نسمعُه نوناً ساكنة: بابٌ، بابًا، بابٍ.';
    for(const id of sample.split(',')){await speak(id,text,path.join(dir,id+'.mp3'));console.log('sample',id)}return}
  const voice=arg('voice');if(!voice)throw new Error('pass --voice <id> (see --list)');
  eval(fs.readFileSync(path.join(__dirname,'voice-key.js'),'utf8'));
  const list=JSON.parse(fs.readFileSync(path.join(OUT,'phrases.json'),'utf8'));
  const done=new Set();try{const m=JSON.parse(fs.readFileSync(path.join(OUT,'voice.json'),'utf8'));if(m.voice===voice)(m.done||[]).forEach(h=>done.add(h))}catch(e){}
  const todo=list.filter(p=>process.argv.includes('--all')?!done.has(p.h):!fs.existsSync(path.join(OUT,p.h+'.mp3')));
  console.log(`${list.length} sentences, ${todo.length} to record, ${todo.reduce((a,p)=>a+p.t.length,0)} characters`);
  let n=0;
  try{for(const p of todo){await speak(voice,p.t,path.join(OUT,p.h+'.mp3'));done.add(p.h);if(++n%20===0)console.log(`  ${n}/${todo.length}`)}}
  catch(e){console.log('Stopped: '+e.message)}
  fs.writeFileSync(path.join(OUT,'voice.json'),JSON.stringify({engine:'elevenlabs',voice,model:MODEL,done:[...done]}));
  const have=list.filter(p=>fs.existsSync(path.join(OUT,p.h+'.mp3'))).map(p=>p.h);
  fs.writeFileSync(path.join(OUT,'list.json'),JSON.stringify(have));
  console.log(`recorded ${n}; voice/list.json: ${have.length}/${list.length}`);
})().catch(e=>{console.log('Error: '+e.message);process.exit(1)});
