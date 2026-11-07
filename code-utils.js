/* CodeSnap: Pure detection/ranking helpers. No user data is persisted. */
(function(global) {
  'use strict';
  const CODE_PATTERN = /(?<![\p{L}\p{N}])(\d(?:[\s\u00a0-]?\d){5})(?![\p{L}\p{N}])/gu;
  const CONTEXT = /(?:confirm(?:ation)?|verif(?:y|ication)|security|login|sign[ -]?in|sign[ -]?up|one[ -]?time|otp|passcode|pin|\bcode\b|best.tigung|sicherheitscode|anmeldecode|einmalcode|kennwort)/i;
  const STRONG_CONTEXT = /(?:confirmation|verification|security|one[ -]?time|best.tigung|\bcode\b|passcode|otp)/i;

  function parseCodes(text, options={}) {
    const value = String(text || '').normalize('NFKC');
    const lines = value.split(/\r?\n/);
    const found = [];
    let offset = 0;
    for (const raw of lines) {
      const line = raw.trim();
      const re = new RegExp(CODE_PATTERN.source, 'gu');
      let match;
      while ((match = re.exec(raw)) !== null) {
        const digits = match[1].replace(/\D/g,'');
        const before = value.slice(Math.max(0,offset+match.index-230),offset+match.index);
        const after = value.slice(offset+match.index+match[0].length,offset+match.index+match[0].length+90);
        let score = 12;
        if (/^\s*\d[\d\s-]{5,12}\s*$/.test(raw)) score += 19;
        if (CONTEXT.test(before)) score += 24;
        if (STRONG_CONTEXT.test(before.slice(-100))) score += 17;
        if (STRONG_CONTEXT.test(after.slice(0,45))) score += 10;
        // Do not mistake a six-digit number in a copyright footer or timestamp for an OTP.
        if (/address|street|road|postal|postcode|zip|copyright|©|phone|telefon|expires?/i.test(raw)) score -= 17;
        if (/\b(?:20\d\d|19\d\d)\b/.test(raw)) score -= 9;
        found.push({code:digits,score,source:options.source || 'full',context:line,offset:offset+match.index});
      }
      offset += raw.length+1;
    }
    return found;
  }

  function getWords(blocks) {
    const words = [];
    for (const block of blocks || []) for (const p of block.paragraphs || []) for (const line of p.lines || []) for (const word of line.words || []) {
      if (typeof word.text === 'string' && word.bbox) words.push({text:word.text.trim(),bbox:word.bbox,confidence:word.confidence || 0});
    }
    return words;
  }

  function locateCode(blocks, code) {
    for (const word of getWords(blocks)) {
      if (word.text.replace(/\D/g,'') === code && /^\D*\d[\d\s-]{4,}\D*$/.test(word.text)) return word.bbox;
    }
    return null;
  }

  function chooseBest(evidence) {
    const grouped = new Map();
    for (const item of evidence) {
      if (!/^\d{6}$/.test(item.code)) continue;
      const entry = grouped.get(item.code) || {code:item.code,score:0,votes:new Set(),contexts:[],confirmed:false};
      if (!entry.votes.has(item.source)) {
        entry.score += item.score || 0;
        entry.votes.add(item.source);
      } else entry.score += Math.min(4,(item.score || 0)*.1);
      entry.contexts.push(item.context || '');
      entry.confirmed ||= item.confirmed === true;
      grouped.set(item.code, entry);
    }
    const rank = [...grouped.values()].map(x => ({ code:x.code, score:Math.round(x.score), votes:x.votes.size, confirmed:x.confirmed })).sort((a,b)=>b.score-a.score || b.votes-a.votes);
    const [best, second] = rank;
    const clear = !!best && (best.confirmed || (best.votes >=2 && best.score>=75)) && (!second || best.score-second.score>=24);
    return {best:best || null, other:rank.slice(1,4), clear, ranked:rank};
  }

  global.CodeSnapUtils = { parseCodes, getWords, locateCode, chooseBest };
})(typeof window !== 'undefined' ? window : globalThis);
