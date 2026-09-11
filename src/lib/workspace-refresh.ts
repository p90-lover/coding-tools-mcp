// Metadata-only refresh. A late read cannot replace a newer local edit.
export function createWorkspaceRefresh<T>(read:()=>Promise<T>,apply:(value:T)=>void,onError:(error:unknown)=>void) {
 let running=false,active=true,generation=0,again=false;
 async function run(invalidate=true):Promise<void>{
  if(!active)return;
  if(running){if(invalidate){generation++;again=true;}return;}
  running=true;
  try {
   do {
    again=false;const ticket=++generation;
    try {const value=await read();if(active&&ticket===generation)apply(value);}
    catch(error){if(active&&ticket===generation)onError(error);}
   } while(active&&again);
  } finally {running=false;}
 }
 return {run,stop(){active=false;generation++;again=false;}};
}
export function workspaceChanged(){
 if(typeof window!=='undefined')window.dispatchEvent(new Event('coding-tools-workspaces-changed'));
}
