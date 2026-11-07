/* CodeSnap 2 – clipboard-only local six-digit OCR for static GitHub Pages. */
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const ui = {
    pasteBtn:$('pasteBtn'), pasteFallback:$('pasteFallback'), pasteTarget:$('pasteTarget'),
    resetBtn:$('resetBtn'), placeholder:$('placeholder'), resultArea:$('resultArea'),
    codeInput:$('codeInput'), copyBtn:$('copyBtn'), qualityMessage:$('qualityMessage'),
    alternatives:$('alternatives'), candidateButtons:$('candidateButtons'),
    progress:$('progress'), progressLabel:$('progressLabel'), progressPercent:$('progressPercent'), progressFill:$('progressFill'),
    status:$('status'),toast:$('toast')
  };
  const U = window.CodeSnapUtils;
  let workerPromise;
  let busy = false;
  let toastTimeout;
  let resetTimeout;
  let lastResult = null;

  function status(message, kind='') {
    ui.status.textContent = message;
    ui.status.className = `status ${kind}`.trim();
  }
  function toast(message) {
    clearTimeout(toastTimeout);
    ui.toast.textContent = message;
    ui.toast.hidden = false;
    toastTimeout = setTimeout(() => {ui.toast.hidden=true;},2200);
  }
  function progress(label, percent=0) {
    ui.progress.hidden = false;
    ui.progressLabel.textContent = label;
    const v = Math.min(100,Math.max(0,Math.round(percent)));
    ui.progressPercent.textContent = `${v} %`;
    ui.progressFill.style.width = `${v}%`;
  }
  function setBusy(value) {
    busy = value;
    ui.pasteBtn.disabled = value;
    ui.resetBtn.disabled = value;
  }
  function clearResult() {
    lastResult = null;
    ui.codeInput.value = '';
    ui.placeholder.hidden = false;
    ui.resultArea.hidden = true;
    ui.alternatives.hidden = true;
    ui.candidateButtons.replaceChildren();
    ui.copyBtn.classList.remove('copied');
    ui.copyBtn.querySelector('span').textContent = 'Kopieren';
  }
  function reset(keepStatus=false) {
    if (busy) return;
    clearTimeout(resetTimeout);
    ui.pasteFallback.hidden = true;
    ui.pasteTarget.replaceChildren();
    ui.progress.hidden = true;
    clearResult();
    if (!keepStatus) status('Bereit für dein kopiertes Foto.');
  }
  function showResult(analysis) {
    clearResult();
    lastResult = analysis;
    ui.codeInput.value = analysis.best.code;
    ui.placeholder.hidden = true;
    ui.resultArea.hidden = false;
    ui.qualityMessage.className = analysis.clear ? 'quality-message' : 'quality-message caution';
    ui.qualityMessage.textContent = analysis.clear
      ? 'Code mehrfach geprüft. Bitte vor der Verwendung kurz kontrollieren.'
      : 'Nicht eindeutig – bitte die Ziffern prüfen und bei Bedarf korrigieren.';
    for (const item of analysis.other) {
      const btn = document.createElement('button');
      btn.type='button'; btn.className='candidate'; btn.textContent=item.code;
      btn.addEventListener('click', () => {
        ui.codeInput.value = item.code;
        ui.qualityMessage.textContent = 'Alternative ausgewählt – bitte kurz prüfen.';
        ui.qualityMessage.className = 'quality-message caution';
      });
      ui.candidateButtons.append(btn);
    }
    ui.alternatives.hidden = analysis.other.length===0;
  }
  async function copyCode(code) {
    if (navigator.clipboard?.writeText) {
      try { await navigator.clipboard.writeText(code); return; }
      catch { /* fallback below */ }
    }
    const temp = document.createElement('textarea');
    temp.value=code;
    temp.style.cssText='position:fixed;top:0;left:-9999px;opacity:0;font-size:16px';
    document.body.appendChild(temp);
    temp.focus(); temp.select(); temp.setSelectionRange(0,code.length);
    const success = document.execCommand('copy');
    temp.remove();
    if (!success) throw new Error('Clipboard write rejected');
  }
  function readImageFromItems(items) {
    for (const item of items || []) {
      if (item.type?.startsWith('image/')) return typeof item.getAsFile==='function' ? item.getAsFile() : item;
    }
    return null;
  }
  async function loadBitmap(blob) {
    try { if (typeof createImageBitmap === 'function') return await createImageBitmap(blob); } catch { /* iPhone fallback */ }
    const url=URL.createObjectURL(blob);
    try {
      const image=new Image();
      await new Promise((resolve,reject) => {image.onload=resolve; image.onerror=reject; image.src=url;});
      return image;
    } finally { URL.revokeObjectURL(url); }
  }
  function imageSize(image) {
    return {width:image.width || image.naturalWidth,height:image.height || image.naturalHeight};
  }
  function makeCanvas(source, rect=null, mode='original', factor=1) {
    const size=imageSize(source);
    const r=rect || {x:0,y:0,width:size.width,height:size.height};
    const maxZoom=Math.min(factor,2600/Math.max(r.width,r.height),Math.sqrt(3500000/(r.width*r.height)));
    const k=Math.max(.1,maxZoom);
    const canvas=document.createElement('canvas');
    canvas.width=Math.max(1,Math.round(r.width*k));
    canvas.height=Math.max(1,Math.round(r.height*k));
    const ctx=canvas.getContext('2d',{willReadFrequently:mode!=='original'});
    ctx.fillStyle='white'; ctx.fillRect(0,0,canvas.width,canvas.height);
    ctx.drawImage(source,r.x,r.y,r.width,r.height,0,0,canvas.width,canvas.height);
    if (mode!=='original') {
      const im=ctx.getImageData(0,0,canvas.width,canvas.height);
      for (let i=0;i<im.data.length;i+=4) {
        const l=im.data[i]*.299+im.data[i+1]*.587+im.data[i+2]*.114;
        const v=mode==='binary' ? (l>=160 ? 255:0) : Math.max(0,Math.min(255,(l-128)*1.55+128));
        im.data[i]=im.data[i+1]=im.data[i+2]=v;
        im.data[i+3]=255;
      }
      ctx.putImageData(im,0,0);
    }
    return canvas;
  }
  function codeRect(box,size) {
    const x0=Math.max(0,Math.min(size.width,box.x0));
    const x1=Math.max(0,Math.min(size.width,box.x1));
    const y0=Math.max(0,Math.min(size.height,box.y0));
    const y1=Math.max(0,Math.min(size.height,box.y1));
    const w=x1-x0,h=y1-y0;
    if (w<=0 || h<=0) return null;
    const padX=Math.max(14,Math.min(48,w*.14)),padY=Math.max(8,h*.22);
    return {x:Math.max(0,x0-padX),y:Math.max(0,y0-padY),width:Math.min(size.width,x1+padX)-Math.max(0,x0-padX),height:Math.min(size.height,y1+padY)-Math.max(0,y0-padY)};
  }
  function mapBoxRect(box,ocrCanvas,originalSize) {
    const r=codeRect(box,{width:ocrCanvas.width,height:ocrCanvas.height});
    if (!r) return null;
    const sx=originalSize.width/ocrCanvas.width,sy=originalSize.height/ocrCanvas.height;
    return {x:r.x*sx,y:r.y*sy,width:r.width*sx,height:r.height*sy};
  }
  function cropBand(size,from,to) {
    const x=size.width*.07;
    return {x,y:size.height*from,width:size.width*.86,height:size.height*(to-from)};
  }
  async function getWorker() {
    if (!window.Tesseract?.createWorker) throw new Error('OCR-Bibliothek konnte nicht geladen werden. Bitte Internetverbindung prüfen und neu laden.');
    if (!workerPromise) {
      workerPromise=window.Tesseract.createWorker('eng',1,{
        logger:(m) => {
          if (busy && m.status==='recognizing text' && typeof m.progress==='number') {
            const current=Number(ui.progressFill.dataset.base||'0');
            progress('Code wird gelesen …', Math.min(96,current+Math.round(m.progress*19)));
          }
        }
      }).catch(error => { workerPromise=null; throw error; });
    }
    return workerPromise;
  }
  async function ocr(worker,canvas,psm,whitelistDigits=false,includeBlocks=false,base=0) {
    ui.progressFill.dataset.base=String(base);
    await worker.setParameters({
      tessedit_pageseg_mode: String(psm),
      tessedit_char_whitelist:whitelistDigits?'0123456789':'',
      preserve_interword_spaces:'1'
    });
    return (await worker.recognize(canvas,{},includeBlocks?{blocks:true}:{text:true})).data;
  }
  async function runRecognition(blob) {
    clearTimeout(resetTimeout);
    if (busy) {toast('Erkennung läuft bereits');return;}
    if (!blob || (!blob.type?.startsWith('image/') && !['application/octet-stream'].includes(blob.type))) {
      status('Bitte ein kopiertes Bild einsetzen, keinen normalen Text.','error'); return;
    }
    clearResult(); ui.pasteFallback.hidden=true; ui.pasteTarget.replaceChildren();
    setBusy(true);
    try {
      progress('Bild wird vorbereitet …',3);
      const source=await loadBitmap(blob);
      const size=imageSize(source);
      if (!size.width || !size.height) throw new Error('Bild konnte nicht geöffnet werden.');
      const canvas=makeCanvas(source);
      const worker=await getWorker();
      const all=[];
      progress('Gesamtes Foto untersuchen …',12);
      const first=await ocr(worker,canvas,11,false,true,16);
      all.push(...U.parseCodes(first.text,{source:'sparse'}));
      let analysis=U.chooseBest(all);

      // The large code often occupies a completely isolated line. Verify its actual glyphs,
      // not just the full page OCR, using a digit-only single-line pass of that word's bbox.
      if (analysis.best) {
        const bbox=U.locateCode(first.blocks,analysis.best.code);
        if (bbox) {
          const rect=mapBoxRect(bbox,canvas,size);
          if (rect) {
            progress('Gefundene Zahlenzeile überprüfen …',38);
            const line=makeCanvas(source,rect,'gray',2);
            const confirmed=await ocr(worker,line,7,true,false,43);
            const digits=(confirmed.text||'').replace(/\D/g,'');
            if (digits.length===6) all.push({code:digits,score:75,source:'line-check',context:'isolated code',confirmed:digits===analysis.best.code});
          }
        }
      }
      analysis=U.chooseBest(all);

      // Whitelist-free sparse OCR is vital: SINGLE_BLOCK frequently omits large standalone codes.
      // Alternate preprocessing is used only if not independently confirmed.
      if (!analysis.clear) {
        progress('Kontrast verbessern …',51);
        const contrasted=makeCanvas(source,null,'gray');
        const second=await ocr(worker,contrasted,11,false,true,54);
        all.push(...U.parseCodes(second.text,{source:'contrast'}));
        const best=U.chooseBest(all).best;
        if (best) {
          const bbox=U.locateCode(second.blocks,best.code);
          if (bbox) {
            const rect=mapBoxRect(bbox,contrasted,size);
            if (rect) {
              const crop=makeCanvas(source,rect,'binary',2);
              const check=await ocr(worker,crop,7,true,false,61);
              const num=(check.text||'').replace(/\D/g,'');
              if (num.length===6) all.push({code:num,score:75,source:'binary-line',context:'isolated code',confirmed:num===best.code});
            }
          }
        }
      }
      analysis=U.chooseBest(all);
      if (!analysis.clear) {
        progress('Weitere Zahlenbereiche prüfen …',70);
        // Overlapping middle sections are useful for templates where the code changes position.
        const bands=[[.10,.42],[.37,.70],[.65,.94]];
        for (let i=0;i<bands.length;i++) {
          if (U.chooseBest(all).clear) break;
          const [a,b]=bands[i];
          const band=makeCanvas(source,cropBand(size,a,b),i===1?'binary':'gray',1.4);
          const result=await ocr(worker,band,11,false,false,72+i*7);
          all.push(...U.parseCodes(result.text,{source:`band-${i}`}));
        }
      }
      analysis=U.chooseBest(all);
      if (!analysis.best) {
        progress('Letzter Erkennungsversuch …',95);
        const last=await ocr(worker,makeCanvas(source,null,'binary'),3,false,false,95);
        all.push(...U.parseCodes(last.text,{source:'fallback'}));
      }
      analysis=U.chooseBest(all);
      if (!analysis.best) {
        status('Kein sechsstelliger Code gefunden. Setze das Foto erneut ein oder verwende einen schärferen Screenshot.','error');
        toast('Kein 6-stelliger Code gefunden');
      } else {
        showResult(analysis);
        status(analysis.clear?'Bestätigungscode erkannt – bereit zum Kopieren.':'Möglicher Code gefunden – bitte prüfen.','ok');
      }
    } catch(err) {
      console.error('CodeSnap OCR',err);
      const isLibrary=/OCR-Bibliothek/.test(err.message || '');
      status(isLibrary?err.message:'Erkennung fehlgeschlagen. Bitte Foto erneut einsetzen.','error');
      toast('Erkennung fehlgeschlagen');
    } finally {
      setBusy(false);
      ui.progress.hidden=true;
      ui.pasteTarget.replaceChildren();
    }
  }

  async function pasteByButton() {
    if (busy) return;
    clearTimeout(resetTimeout);
    // Clipboard read has to be initiated in the immediate click-handler activation.
    if (navigator.clipboard?.read) {
      try {
        const items=await navigator.clipboard.read();
        for (const item of items) {
          const type=item.types.find(t=>t.startsWith('image/'));
          if (type) {await runRecognition(await item.getType(type)); return;}
        }
        status('In der Zwischenablage ist kein Bild. Bitte zuerst einen Screenshot kopieren.','error');
      } catch(e) {
        // iOS Safari frequently denies image clipboard reads to web sites; use native Paste menu.
        status('Jetzt unten ins Feld lange drücken und „Einsetzen“ auswählen.');
      }
    } else status('Jetzt unten ins Feld lange drücken und „Einsetzen“ auswählen.');
    ui.pasteFallback.hidden=false;
    ui.pasteTarget.focus({preventScroll:true});
  }
  ui.pasteBtn.addEventListener('click',pasteByButton);
  ui.resetBtn.addEventListener('click',()=>reset());
  ui.copyBtn.addEventListener('click',async () => {
    if (busy) return;
    const code=ui.codeInput.value.trim();
    if (!/^\d{6}$/.test(code)) {status('Bitte genau sechs Ziffern eingeben.','error');return;}
    try {
      await copyCode(code);
      ui.copyBtn.classList.add('copied');
      ui.copyBtn.querySelector('span').textContent='Kopiert!';
      toast('Nur der Code wurde kopiert');
      status('Code kopiert. Bereit für den nächsten Screenshot.','ok');
      // Delay lets the user see success without requiring another interaction.
      resetTimeout=setTimeout(()=>reset(),650);
    } catch {
      status('Kopieren wurde blockiert. Bitte die Ziffern markieren und kopieren.','error');
      toast('Kopieren nicht erlaubt');
    }
  });
  ui.codeInput.addEventListener('input',() => {
    ui.codeInput.value=ui.codeInput.value.replace(/\D/g,'').slice(0,6);
  });

  document.addEventListener('paste',event => {
    const file=readImageFromItems(event.clipboardData?.items) || readImageFromItems(event.clipboardData?.files);
    if (!file) {
      if (document.activeElement===ui.pasteTarget) {
        event.preventDefault();
        status('In der Zwischenablage befindet sich nur Text – bitte ein Foto kopieren.','error');
      }
      return;
    }
    event.preventDefault();
    runRecognition(file);
  });
  ui.pasteTarget.addEventListener('input',async () => {
    const img=ui.pasteTarget.querySelector('img');
    if (!img) {
      if (ui.pasteTarget.textContent.trim()) {ui.pasteTarget.replaceChildren(); status('Bitte ein Bild und keinen Text einsetzen.','error');}
      return;
    }
    const url=img.getAttribute('src');
    ui.pasteTarget.replaceChildren();
    if (!url || !/^(data:image\/|blob:)/i.test(url)) {status('Eingesetztes Bildformat nicht unterstützt.','error');return;}
    try {const response=await fetch(url); await runRecognition(await response.blob());}
    catch {status('Eingesetztes Foto konnte nicht geladen werden.','error');}
  });
  reset();
})();
