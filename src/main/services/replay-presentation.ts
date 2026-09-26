/** Browser-only helpers serialized into the isolated replay shell. They receive
 * only replay DOM, never a business page or a host capability. */
export function replayHit(frame:HTMLIFrameElement,x:number,y:number):{node:Element;rect:{x:number;y:number;width:number;height:number}}|undefined{
  let document=frame.contentDocument;if(!document)return;
  const box=frame.getBoundingClientRect();
  let sx=box.width/(frame.contentWindow?.innerWidth||frame.clientWidth||box.width),sy=box.height/(frame.contentWindow?.innerHeight||frame.clientHeight||box.height),ox=box.left,oy=box.top;
  x=(x-ox)/sx;y=(y-oy)/sy;
  let element=document.elementFromPoint(x,y);
  for(let depth=0;element&&depth<64;depth++){
    if(element.shadowRoot){const child=element.shadowRoot.elementFromPoint(x,y);if(child&&child!==element){element=child;continue;}}
    if(element.tagName==='IFRAME'){
      const child=element as HTMLIFrameElement,childDocument=child.contentDocument;
      if(!childDocument)return;
      const rect=child.getBoundingClientRect(),childX=rect.width/(child.contentWindow?.innerWidth||child.clientWidth||rect.width),childY=rect.height/(child.contentWindow?.innerHeight||child.clientHeight||rect.height);
      ox+=rect.left*sx;oy+=rect.top*sy;sx*=childX;sy*=childY;x=(x-rect.left)/childX;y=(y-rect.top)/childY;
      document=childDocument;element=document.elementFromPoint(x,y);continue;
    }
    const rect=element.getBoundingClientRect();return {node:element,rect:{x:ox+rect.left*sx,y:oy+rect.top*sy,width:rect.width*sx,height:rect.height*sy}};
  }
}
export async function waitReplayPresentation(document:Document,generation:number):Promise<string[]>{
  const errors:string[]=[],started=Date.now();
  const current=()=>{if((window as any).__besGeneration!==generation)throw new Error('Replay seek superseded');};
  const assets=()=>{
    const roots:Array<Document|ShadowRoot>=[document],documents:Document[]=[document],links:HTMLLinkElement[]=[],images:HTMLImageElement[]=[];
    for(let index=0;index<roots.length;index++){
      if(roots.length>128)throw new Error('Replay frame/shadow asset scope exceeds budget');
      const root=roots[index];links.push(...root.querySelectorAll<HTMLLinkElement>('link[rel=stylesheet]'));images.push(...root.querySelectorAll<HTMLImageElement>('img'));
      for(const element of root.querySelectorAll('*')){
        if(element.shadowRoot)roots.push(element.shadowRoot);
        if(element.tagName==='IFRAME'){
          const child=(element as HTMLIFrameElement).contentDocument;
          if(child&&!documents.includes(child)){documents.push(child);roots.push(child);}
          else if(!child&&errors.length<64)errors.push('Archived child frame is unavailable');
        }
      }
    }
    if(links.length+images.length>5000)throw new Error('Replay asset element budget exceeded');
    return {links,images,documents};
  };
  while(true){
    current();
    const {links,images,documents}=assets();
    for(const child of documents)void child.body?.offsetHeight;
    const pending=links.some(link=>!link.sheet)||images.some(image=>!image.complete)||documents.some(child=>child.fonts.status==='loading');
    if(!pending){for(const image of images)if(image.src&&image.naturalWidth===0&&errors.length<64)errors.push('Archived image failed to decode');for(const child of documents)child.fonts.forEach(face=>{if(face.status==='error'&&errors.length<64)errors.push('Archived font failed to decode');});break;}
    if(Date.now()-started>=5000){
      if(links.some(link=>!link.sheet))errors.push('Archived stylesheet did not become ready within 5 seconds');
      if(images.some(image=>!image.complete))errors.push('Archived image did not become ready within 5 seconds');
      if(documents.some(child=>child.fonts.status==='loading'))errors.push('Archived fonts did not become ready within 5 seconds');break;
    }
    await new Promise(resolve=>setTimeout(resolve,25));
  }
  await new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve())));current();return errors;
}
