/** A CDP Font classification is required by callers before correcting a generic
 * response MIME. A URL extension alone never upgrades arbitrary binary bytes. */
export function observedFontMediaType(bytes:Uint8Array):string|undefined {
  if(bytes.length<12)return;
  const signature=Buffer.from(bytes.buffer,bytes.byteOffset,4);
  if(signature.equals(Buffer.from([0,1,0,0])))return 'font/ttf';
  return ({OTTO:'font/otf',wOFF:'font/woff',wOF2:'font/woff2',ttcf:'font/collection'} as Record<string,string>)[signature.toString('ascii')];
}
