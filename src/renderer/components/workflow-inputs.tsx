import React,{useEffect,useState} from 'react';
import {Input} from './ui/input';
import {Textarea} from './ui/textarea';
import {NativeSelect} from './ui/native-select';
import {Label} from './ui/label';

/** Plain scalar schemas get ordinary controls; complex schemas retain exact JSON. */
export function WorkflowInputs({projectId,directory,value,onChange}:{projectId:string;directory?:string;value:string;onChange(value:string):void}){
 const [schema,setSchema]=useState<any>(null),[error,setError]=useState('');
 useEffect(()=>{let alive=true;setSchema(null);setError('');if(projectId&&directory)void window.studio.call('workflowInputSchema',{projectId}).then(result=>{if(alive)setSchema(result.schema);}).catch(error=>{if(alive)setError(String(error));});return()=>{alive=false;};},[projectId,directory]);
 let input:any;try{input=JSON.parse(value);}catch{}
 const entries=Object.entries(schema?.properties??{}) as [string,any][];
 const supported=schema?.type==='object'&&entries.length>0&&entries.length<=50&&entries.every(([,property])=>property&&['string','number','integer','boolean'].includes(property.type)&&!property.oneOf&&!property.anyOf&&!property.$ref);
 const editable=input&&typeof input==='object'&&!Array.isArray(input);
 const change=(key:string,next:unknown)=>{if(!editable)return;const result={...input};if(next===undefined)delete result[key];else Object.defineProperty(result,key,{value:next,enumerable:true,configurable:true,writable:true});onChange(JSON.stringify(result,null,2));};
 const json=<Label>输入 JSON<Textarea className="code-input" rows={7} value={value} onChange={event=>onChange(event.target.value)} spellCheck={false}/></Label>;
 return <section aria-label="运行参数">{error&&<p role="alert">参数表单读取失败：{error}。原输入保留。</p>}{supported&&editable?<>{entries.map(([key,property])=><Label key={key}>{property.title||key}{schema.required?.includes(key)?'（必填）':''}{property.description&&<small>{property.description}</small>}{property.enum?<NativeSelect value={JSON.stringify(input[key])??''} onChange={e=>change(key,e.target.value===''?undefined:JSON.parse(e.target.value))}><option value="">未设置</option>{property.enum.map((option:any,index:number)=><option key={index} value={JSON.stringify(option)}>{String(option)}</option>)}</NativeSelect>:property.type==='boolean'?<NativeSelect value={input[key]===undefined?'':String(input[key])} onChange={e=>change(key,e.target.value===''?undefined:e.target.value==='true')}><option value="">未设置</option><option value="true">是</option><option value="false">否</option></NativeSelect>:<Input type={property.type==='string'?'text':'number'} step={property.type==='integer'?1:'any'} min={property.minimum} max={property.maximum} value={input[key]??''} onChange={e=>change(key,e.target.value===''?undefined:property.type==='string'?e.target.value:Number(e.target.value))}/>}</Label>)}<details><summary>高级输入 JSON</summary>{json}</details></>:json}</section>;
}
