/** Drain every owned resource, persist the final identity while still owning the
 * workspace, then release the workspace lease last. No callback runs afterward. */
export async function shutdownNodeWorkspace(
  stops:ReadonlyArray<()=>unknown|Promise<unknown>>,
  finalizeLaunch:(clean:boolean)=>unknown|Promise<unknown>,
  releaseLease:()=>unknown|Promise<unknown>,
):Promise<void>{
  const errors:unknown[]=[];
  for(const stop of stops)try{await stop();}catch(error){errors.push(error);}
  try{await finalizeLaunch(errors.length===0);}catch(error){errors.push(error);}
  try{await releaseLease();}catch(error){errors.push(error);}
  if(errors.length)throw new AggregateError(errors,'Node shutdown could not fully drain');
}
