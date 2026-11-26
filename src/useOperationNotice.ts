import {useCallback,useEffect,useState,type SetStateAction} from 'react';
import {logLevel,terminalPublish} from './terminalLogLogic';
/** One producer for an operation result: logs once, notifies only explicit failures.
 * Clearing at the start of a retry makes even an identical synchronous failure new. */
export function useOperationNotice(source:string) {
 const [result,setResult]=useState({message:'',failed:false,key:''});
 const setNotice=useCallback((value:SetStateAction<string>,failed=false)=>setResult(previous=>{
  const message=typeof value==='function'?value(previous.message):value;
  if(message===previous.message&&failed===previous.failed)return previous;
  return {message,failed,key:failed?crypto.randomUUID():''};
 }),[]);
 useEffect(()=>{if(result.message)terminalPublish({source,message:result.message,level:result.failed?'error':logLevel(result.message),failure:result.failed?{key:result.key,title:`${source} · 操作失败`}:undefined});},[source,result]);
 return [result.message,setNotice] as const;
}
