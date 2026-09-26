/** Wait until the caller's monotonic elapsed clock reaches the measured duration. */
export async function waitForMeasuredDuration(durationMs:number,elapsed:()=>number,wait:(ms:number)=>Promise<unknown>):Promise<number>{
  let measured=elapsed();
  while(measured<durationMs){
    await wait(Math.max(1,durationMs-measured));
    measured=elapsed();
  }
  return measured;
}
