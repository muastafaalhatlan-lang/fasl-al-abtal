// Shared by the game and the voice tools: one stable file name per sentence.
function normVoice(t){return String(t||'').replace(/\s+/g,' ').trim()}
function voiceKey(t){t=normVoice(t);let h=0x811c9dc5;for(let i=0;i<t.length;i++){h^=t.charCodeAt(i);h=Math.imul(h,16777619)>>>0}return h.toString(16).padStart(8,'0')}
