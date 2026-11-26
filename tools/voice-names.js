// Records student names for the morning board's «اختيار طالب» into voice/names/<hash>.mp3 (+ list.json, _intro.mp3).
//   node tools/voice-names.js --voice <id>         (only missing names)
//   node tools/voice-names.js --voice <id> --all   (re-record everything, e.g. after changing voice)
// The hash must match nameHash() in morning.html. Needs curl and ffmpeg; the ElevenLabs key is injected by the proxy.
const fs=require('fs'),path=require('path'),os=require('os'),{execFileSync}=require('child_process');
const ROOT=path.join(__dirname,'..'),OUT=path.join(ROOT,'voice','names');fs.mkdirSync(OUT,{recursive:true});
const arg=(n,d)=>{const i=process.argv.indexOf('--'+n);return i>0?process.argv[i+1]:d};
const voice=arg('voice');if(!voice)throw new Error('pass --voice <id>');
const TMP=fs.mkdtempSync(path.join(os.tmpdir(),'names-'));
const key=n=>n.replace(/[ً-ٰٟـ]/g,'').replace(/[أإآ]/g,'ا').replace(/\s+/g,'');
const hash=n=>{let h=0x811c9dc5;const k=key(n);for(let i=0;i<k.length;i++){h^=k.charCodeAt(i);h=Math.imul(h,0x01000193)>>>0}return h.toString(16).padStart(8,'0')};
function speak(text,out){
  fs.writeFileSync(path.join(TMP,'req.json'),JSON.stringify({text,model_id:'eleven_multilingual_v2',voice_settings:{stability:0.55,similarity_boost:0.8,style:0.3,use_speaker_boost:true,speed:0.95}}));
  const raw=path.join(TMP,'raw.mp3');
  const code=execFileSync('curl',['-sS','--max-time','60','-X','POST','-H','xi-api-key: '+(process.env.ELEVEN_API_KEY||'proxy-injected'),'-H','Content-Type: application/json','--data-binary','@'+path.join(TMP,'req.json'),'-o',raw,'-w','%{http_code}',
    `https://api.elevenlabs.io/v1/text-to-speech/${voice}?output_format=mp3_44100_64`]).toString();
  if(code!=='200')throw new Error('HTTP '+code+' '+fs.readFileSync(raw,'utf8').slice(0,200));
  execFileSync('ffmpeg',['-hide_banner','-loglevel','error','-y','-i',raw,'-af','silenceremove=start_periods=1:start_threshold=-45dB,areverse,silenceremove=start_periods=1:start_threshold=-45dB,areverse,loudnorm=I=-14:TP=-1.0','-ac','1','-ar','24000','-b:a','48k',out]);
}
const all=process.argv.includes('--all');
const intro=path.join(OUT,'_intro.mp3');if(all||!fs.existsSync(intro)){speak('البَطَلُ المُخْتَارُ هُوَ...',intro);console.log('intro')}
const lines=fs.readFileSync(path.join(__dirname,'student-names.txt'),'utf8').split('\n').map(l=>l.trim()).filter(l=>l&&!l.startsWith('#'));
const seen=new Map();for(const l of lines){const [n,say]=l.split('|');seen.set(hash(n),say||n)}
let made=0;for(const [h,say] of seen){const f=path.join(OUT,h+'.mp3');if(!all&&fs.existsSync(f))continue;speak(say+'!',f);if(++made%25===0)console.log(made)}
fs.writeFileSync(path.join(OUT,'list.json'),JSON.stringify([...seen.keys()].filter(h=>fs.existsSync(path.join(OUT,h+'.mp3'))).sort()));
console.log(`done: ${made} recorded, ${seen.size} names`);
