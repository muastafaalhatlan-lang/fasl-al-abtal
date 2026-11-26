// Records student names for the morning board's «اختيار طالب» into voice/names/<hash>.mp3 (+ list.json, _intro.mp3).
//   node tools/voice-names.js --voice <id>         (only missing names)
//   node tools/voice-names.js --voice <id> --all   (re-record everything, e.g. after changing voice)
//   node tools/voice-names.js --voice <id> --dir names-m --lead "_bravo:أَحْسَنْتَ يَا"   (another voice/set, e.g. stars)
// The hash must match nameHash() in morning.html. Needs curl and ffmpeg; the ElevenLabs key is injected by the proxy.
const fs=require('fs'),path=require('path'),os=require('os'),{execFileSync}=require('child_process');
const ROOT=path.join(__dirname,'..'),OUT=path.join(ROOT,'voice',(process.argv.includes('--dir')?process.argv[process.argv.indexOf('--dir')+1]:'names'));fs.mkdirSync(OUT,{recursive:true});
const arg=(n,d)=>{const i=process.argv.indexOf('--'+n);return i>0?process.argv[i+1]:d};
const voice=arg('voice');if(!voice)throw new Error('pass --voice <id>');
const TMP=fs.mkdtempSync(path.join(os.tmpdir(),'names-'));
const key=n=>n.replace(/[ً-ٰٟـ]/g,'').replace(/[أإآ]/g,'ا').replace(/\s+/g,'');
const hash=n=>{let h=0x811c9dc5;const k=key(n);for(let i=0;i<k.length;i++){h^=k.charCodeAt(i);h=Math.imul(h,0x01000193)>>>0}return h.toString(16).padStart(8,'0')};
// Short texts can make the model invent extra words, so every clip is checked with speech-to-text and re-recorded until it matches.
const norm=t=>String(t).replace(/[\u064B-\u065F\u0670\u0640]/g,'').replace(/[أإآ]/g,'ا').replace(/ة/g,'ه').replace(/ى/g,'ي').replace(/[^\u0621-\u064A\s]/g,' ').replace(/\s+/g,' ').trim();
function heard(file){const out=execFileSync('curl',['-sS','--max-time','60','-X','POST','-H','xi-api-key: '+(process.env.ELEVEN_API_KEY||'proxy-injected'),'-F','model_id=scribe_v1','-F','language_code=ara','-F','file=@'+file,'https://api.elevenlabs.io/v1/speech-to-text']).toString();
  try{return norm(JSON.parse(out).text||'')}catch(e){return ''}}
function matches(file,expect){const h=heard(file).replace(/\s/g,''),e=norm(expect).replace(/\s/g,'');return {ok:h===e,h}}
function speak(text,out,expect,prev){
  for(let a=0;a<5;a++){speakOnce(text,out,prev,a);if(!expect)return;const m=matches(out,expect);if(m.ok)return;console.log(`  retry ${expect}: heard "${m.h}"`)}
  console.log(`  WARNING ${expect}: still not clean after 5 tries`);
}
function speakOnce(text,out,prev,attempt){
  const body={text,model_id:'eleven_multilingual_v2',voice_settings:{stability:0.8,similarity_boost:0.75,style:0,use_speaker_boost:true,speed:0.92}};
  if(prev)body.previous_text=prev;if(attempt)body.seed=1000+attempt;
  fs.writeFileSync(path.join(TMP,'req.json'),JSON.stringify(body));
  const raw=path.join(TMP,'raw.mp3');
  const code=execFileSync('curl',['-sS','--max-time','60','-X','POST','-H','xi-api-key: '+(process.env.ELEVEN_API_KEY||'proxy-injected'),'-H','Content-Type: application/json','--data-binary','@'+path.join(TMP,'req.json'),'-o',raw,'-w','%{http_code}',
    `https://api.elevenlabs.io/v1/text-to-speech/${voice}?output_format=mp3_44100_64`]).toString();
  if(code!=='200')throw new Error('HTTP '+code+' '+fs.readFileSync(raw,'utf8').slice(0,200));
  execFileSync('ffmpeg',['-hide_banner','-loglevel','error','-y','-i',raw,'-af','silenceremove=start_periods=1:start_threshold=-45dB,areverse,silenceremove=start_periods=1:start_threshold=-45dB,areverse,loudnorm=I=-14:TP=-1.0','-ac','1','-ar','24000','-b:a','48k',out]);
}
const all=process.argv.includes('--all');
const leads=arg('lead')?[arg('lead').split(':')]:[['_intro','البَطَلُ المُخْتَارُ هُوَ...'],['_hello','أَهْلاً يَا']];
const leadPrev=leads[leads.length-1][1].replace(/\.+$/,'');
const verify=process.argv.includes('--verify');
for(const [f,txt] of leads){const o=path.join(OUT,f+'.mp3');const exp=txt.replace(/\.+$/,'');if(all||!fs.existsSync(o)||(verify&&!matches(o,exp).ok)){speak(txt,o,exp);console.log(f)}}
const lines=fs.readFileSync(path.join(__dirname,'student-names.txt'),'utf8').split('\n').map(l=>l.trim()).filter(l=>l&&!l.startsWith('#'));
const seen=new Map();for(const l of lines){const [n,say]=l.split('|');seen.set(hash(n),say||n)}
let made=0,checked=0;for(const [h,say] of seen){const f=path.join(OUT,h+'.mp3');
  if(!all&&fs.existsSync(f)){if(!verify)continue;checked++;const m=matches(f,say);if(m.ok)continue;console.log(`bad ${say}: heard "${m.h}"`)}
  speak(say+'.',f,say,leadPrev);if(++made%25===0)console.log(made)}
if(verify)console.log(`checked ${checked}`);
fs.writeFileSync(path.join(OUT,'list.json'),JSON.stringify([...seen.keys()].filter(h=>fs.existsSync(path.join(OUT,h+'.mp3'))).sort()));
console.log(`done: ${made} recorded, ${seen.size} names`);
