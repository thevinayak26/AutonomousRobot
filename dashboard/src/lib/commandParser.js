const COMMANDS = {
  NAVIGATE: { en:['go','move','navigate','head','drive','take me'], hi:['जा','चलो','चल','पहुँच'], hi_rom:['jao','jaao','chalo','chal'], es:['ir','ve','anda'], ta:['போ'] },
  STOP:     { en:['stop','halt','freeze'], hi:['रुको','ठहरो'], hi_rom:['ruko','ruk','thahro'], es:['para','detente','alto'], ta:['நிறுத்து'] },
  RETURN:   { en:['return','come back','go back','home'], hi:['वापस','घर'], hi_rom:['wapas','vapas','ghar'], es:['vuelve','regresa'], ta:['திரும்பு'] },
};
const TARGETS = {
  dock:    ['dock','docking','डॉक','dak','charger','charging','चार्जर'],
  desk:    ['desk','desk a','deska','table','मेज','मेज़','mez','escritorio'],
  window:  ['window','खिड़की','khidki','ventana','சாளரம்'],
  doorway: ['doorway','door','दरवाज','darwaz','puerta','கதவு','gate'],
};
const TARGETLESS = new Set(['STOP','RETURN']);
const isAscii = (s) => /^[\x00-\x7F]*$/.test(s);
function matches(low, raw, phrases){
  const lowNs = low.replace(/ /g,'');
  for (const p of phrases){
    if (isAscii(p)){ if (low.includes(p.toLowerCase()) || lowNs.includes(p.replace(/ /g,''))) return true; }
    else if (raw.includes(p)) return true;
  }
  return false;
}
export function parseCommand(transcript){
  if (!transcript) return null;
  const raw = transcript.trim().replace(/\s+/g,' ');
  const low = raw.toLowerCase();
  let command = null;
  for (const [cmd, langs] of Object.entries(COMMANDS)){
    for (const phrases of Object.values(langs)){ if (matches(low, raw, phrases)){ command = cmd; break; } }
    if (command) break;
  }
  if (!command) return null;
  if (TARGETLESS.has(command)) return { command, target:null };
  let target = null;
  for (const [tgt, phrases] of Object.entries(TARGETS)){ if (matches(low, raw, phrases)){ target = tgt; break; } }
  if (!target) return null;
  return { command, target };
}
