// Records student names for the morning board into voice/<dir>/<hash>.mp3 (+ list.json and the lead-in clip).
//
//   node tools/voice-names.js --voice <id> [--dir names] [--lead "_hello:أَهْلاً يَا"] [--intro "_intro:البَطَلُ المُخْتَارُ هُوَ..."] [--all]
//
// Single short words make the TTS model invent extra words, so each name is spoken inside a sentence
// ("أهلاً يا فيصل!"), checked with ElevenLabs speech-to-text, and the name alone is cut out using the
// word timings. Clips that never come out clean are left out of list.json (the page then skips them).
// The hash must match nameHash() in morning.html. Needs curl and ffmpeg; the key is injected by the proxy.
const fs=require('fs'),path=require('path'),os=require('os'),{execFileSync}=require('child_process');
const arg=(n,d)=>{const i=process.argv.indexOf('--'+n);return i>0?process.argv[i+1]:d};
const voice=arg('voice');if(!voice)throw new Error('pass --voice <id>');
const ROOT=path.join(__dirname,'..'),OUT=path.join(ROOT,'voice',arg('dir','names'));fs.mkdirSync(OUT,{recursive:true});
const TMP=fs.mkdtempSync(path.join(os.tmpdir(),'names-'));const KEY=process.env.ELEVEN_API_KEY||'proxy-injected';
const all=process.argv.includes('--all');
const [leadFile,leadText]=arg('lead','_hello:أَهْلاً يَا').split(':');
const intro=arg('intro',arg('dir','names')==='names'?'_intro:البَطَلُ المُخْتَارُ هُوَ...':'');

const key=n=>n.replace(/[ً-ٰٟـ]/g,'').replace(/[أإآ]/g,'ا').replace(/\s+/g,'');
const hash=n=>{let h=0x811c9dc5;const k=key(n);for(let i=0;i<k.length;i++){h^=k.charCodeAt(i);h=Math.imul(h,0x01000193)>>>0}return h.toString(16).padStart(8,'0')};
const norm=t=>String(t).replace(/[ً-ٰٟـ]/g,'').replace(/[أإآ]/g,'ا').replace(/ة/g,'ه').replace(/ى/g,'ي').replace(/[^ء-ي]/g,'');
const sleep=s=>execFileSync('sleep',[String(s)]);

function tts(text,out,attempt){
  // turbo v2.5 with the language locked to Arabic: cheaper, and it cannot drift into an English reading
  const body={text,model_id:arg('model','eleven_turbo_v2_5'),language_code:'ar'};
  if(attempt)body.seed=777+attempt*13;
  fs.writeFileSync(path.join(TMP,'req.json'),JSON.stringify(body));
  for(let a=0;a<5;a++){
    const code=execFileSync('curl',['-sS','--max-time','60','-X','POST','-H','xi-api-key: '+KEY,'-H','Content-Type: application/json','--data-binary','@'+path.join(TMP,'req.json'),'-o',out,'-w','%{http_code}',
      `https://api.elevenlabs.io/v1/text-to-speech/${voice}?output_format=mp3_44100_128`]).toString();
    if(code==='200')return;
    const msg=fs.readFileSync(out,'utf8').slice(0,200);if(code==='429'||code>='500'){sleep(5*(a+1));continue}
    throw new Error('HTTP '+code+' '+msg);
  }
  throw new Error('too many retries');
}
function stt(file){
  for(let a=0;a<6;a++){
    try{const r=JSON.parse(execFileSync('curl',['-sS','--max-time','60','-X','POST','-H','xi-api-key: '+KEY,'-F','model_id=scribe_v1','-F','language_code=ara','-F','file=@'+file,'https://api.elevenlabs.io/v1/speech-to-text']).toString());
      if(typeof r.text==='string')return r}catch(e){}
    sleep(3*(a+1));
  }
  return null;
}
const ff=args=>execFileSync('ffmpeg',['-hide_banner','-loglevel','error','-y',...args]);
const finish=(src,out,ss,to)=>ff(['-i',src,...(ss!=null?['-ss',ss.toFixed(3),'-to',to.toFixed(3)]:[]),'-af','silenceremove=start_periods=1:start_threshold=-45dB,areverse,silenceremove=start_periods=1:start_threshold=-45dB,areverse,loudnorm=I=-14:TP=-1.0','-ac','1','-ar','24000','-b:a','48k',out]);

// a whole phrase (lead-in / intro): must be heard exactly
function phrase(file,text){
  const out=path.join(OUT,file+'.mp3');if(!all&&fs.existsSync(out)&&norm((stt(out)||{}).text)===norm(text))return;
  for(let a=0;a<6;a++){const raw=path.join(TMP,'raw.mp3');tts(text,raw,a);const r=stt(raw);
    if(r&&norm(r.text)===norm(text)){finish(raw,out);console.log('ok',file);return}console.log('  retry',file,'heard:',r&&r.text)}
  console.log('WARNING',file,'not clean');
}
// a name: spoken after the lead-in, then cut out by the word timings
function name(say,out){
  const text=`${leadText} ${say}!`,want=norm(leadText+say),leadWords=leadText.trim().split(/\s+/).length;
  for(let a=0;a<6;a++){const raw=path.join(TMP,'raw.mp3');tts(text,raw,a);const r=stt(raw);
    const words=r?(r.words||[]).filter(w=>w.type==='word'):[];
    if(r&&norm(r.text)===want&&words.length>leadWords){
      // the sentence was heard exactly; a lone short word confuses speech-to-text, so the cut is only checked for real sound
      const st=Math.max(0,words[leadWords].start-0.02),en=words[words.length-1].end+0.12;
      finish(raw,out,st,en);
      const dur=+execFileSync('ffprobe',['-v','error','-show_entries','format=duration','-of','csv=p=0',out]).toString();
      const vol=+((execFileSync('ffmpeg',['-hide_banner','-i',out,'-af','volumedetect','-f','null','-'],{stdio:['ignore','pipe','pipe']}).toString()+'').match(/max_volume: (-?[\d.]+)/)||[0,-99])[1];
      if(dur>=0.2&&dur<=2.5)return true;
      console.log('  cut retry',say,'duration',dur);continue}
    console.log('  retry',say,'heard:',r&&r.text)}
  return false;
}

if(intro){const [f,t]=intro.split(':');phrase(f,t)}
phrase(leadFile,leadText);
const lines=fs.readFileSync(arg('names',path.join(__dirname,'student-names.txt')),'utf8').split('\n').map(l=>l.trim()).filter(l=>l&&!l.startsWith('#'));
const seen=new Map();for(const l of lines){const [n,say]=l.split('|');seen.set(hash(n),[n,say||n])}
let listed=[];try{listed=JSON.parse(fs.readFileSync(path.join(OUT,'list.json'),'utf8'))}catch(e){}
const good=new Set(all?[]:listed),bad=[];let done=0;
for(const [h,[n,say]] of seen){
  const f=path.join(OUT,h+'.mp3');
  if(!all&&good.has(h)&&fs.existsSync(f))continue;
  if(name(say,f))good.add(h);else{good.delete(h);bad.push(n)}
  if(++done%20===0)console.log(done,'names');
}
fs.writeFileSync(path.join(OUT,'list.json'),JSON.stringify([...good].filter(h=>seen.has(h)).sort()));
console.log(`done: ${good.size} clean, ${bad.length} not clean${bad.length?': '+bad.join('، '):''}`);
