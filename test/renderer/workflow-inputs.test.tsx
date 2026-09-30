/** @vitest-environment jsdom */
import { setTestWorkbenchClient, clearTestWorkbenchClient } from './workbench-test-client';
import React,{useState} from 'react';
import Ajv from 'ajv';
import {cleanup,fireEvent,render,screen,waitFor} from './workbench-test-client';
import {afterEach,expect,test,vi} from 'vitest';
import {WorkflowInputs} from '@/renderer/components/workflow-inputs';
afterEach(()=>{cleanup();clearTestWorkbenchClient();});
test('scalar forms retain numeric and boolean meaning and untouched advanced properties',async()=>{
 setTestWorkbenchClient({bounds:vi.fn(),call:vi.fn(async()=>({schema:{type:'object',properties:{count:{type:'integer',title:'记录数'},enabled:{type:'boolean',title:'包含归档'}}}}))});
 function Form(){const [value,set]=useState('{"extra":{"keep":true}}');return <WorkflowInputs projectId="project" directory="registered" value={value} onChange={set}/>;}
 render(<Form/>);fireEvent.change(await screen.findByLabelText('记录数'),{target:{value:'2'}});fireEvent.change(screen.getByLabelText('包含归档'),{target:{value:'false'}});
 expect(JSON.parse((screen.getByLabelText('输入 JSON') as HTMLTextAreaElement).value)).toEqual({extra:{keep:true},count:2,enabled:false});
 fireEvent.change(screen.getByLabelText('记录数'),{target:{value:''}});expect(JSON.parse((screen.getByLabelText('输入 JSON') as HTMLTextAreaElement).value)).not.toHaveProperty('count');
});
test('late schemas cannot replace the new project and unsupported schemas preserve JSON',async()=>{
 let finish!:(value:any)=>void;const old=new Promise(resolve=>{finish=resolve;});setTestWorkbenchClient({bounds:vi.fn(),call:vi.fn(async(_method,body:any)=>body.projectId==='old'?old:{schema:{type:'object',properties:{nested:{type:'object'}}}})});
 const view=render(<WorkflowInputs projectId="old" directory="a" value="{}" onChange={vi.fn()}/>);view.rerender(<WorkflowInputs projectId="new" directory="b" value="{}" onChange={vi.fn()}/>);
 finish({schema:{type:'object',properties:{bad:{type:'string',title:'Late field'}}}});await waitFor(()=>expect(screen.queryByLabelText('Late field')).toBeNull());expect(screen.getByLabelText('输入 JSON')).toBeTruthy();
});

test('clearing a required string preserves an empty value instead of removing the parameter',async()=>{
 const schema={type:'object',required:['query'],properties:{query:{type:'string',title:'查询词'},limit:{type:'integer',title:'上限'}}};
 const validate=new Ajv({allErrors:true,strict:true}).compile(schema);
 setTestWorkbenchClient({bounds:vi.fn(),call:vi.fn(async()=>({schema}))});
 function Form(){const [value,set]=useState('{"query":"previous","limit":3,"extra":{"keep":true}}');return <WorkflowInputs projectId="project" directory="registered" value={value} onChange={set}/>;}
 render(<Form/>);
 fireEvent.change(await screen.findByLabelText('查询词（必填）'),{target:{value:''}});
 const cleared=JSON.parse((screen.getByLabelText('输入 JSON') as HTMLTextAreaElement).value);
 expect(cleared).toEqual({query:'',limit:3,extra:{keep:true}});
 expect(validate(cleared)).toBe(true);
 fireEvent.change(screen.getByLabelText('上限'),{target:{value:''}});
 expect(JSON.parse((screen.getByLabelText('输入 JSON') as HTMLTextAreaElement).value)).toEqual({query:'',extra:{keep:true}});
 fireEvent.change(screen.getByLabelText('查询词（必填）'),{target:{value:'new query'}});
 expect(JSON.parse((screen.getByLabelText('输入 JSON') as HTMLTextAreaElement).value)).toEqual({query:'new query',extra:{keep:true}});
});
test.each([false,true])('cleared strings remain subject to minLength validation (required=%s)',async(required)=>{
 const schema={type:'object',...(required?{required:['query']}:{}),properties:{query:{type:'string',minLength:1,title:'查询词'}}};
 const validate=new Ajv({allErrors:true,strict:true}).compile(schema);
 setTestWorkbenchClient({bounds:vi.fn(),call:vi.fn(async()=>({schema}))});
 function Form(){const [value,set]=useState('{"query":"previous"}');return <WorkflowInputs projectId="project" directory="registered" value={value} onChange={set}/>;}
 render(<Form/>);
 fireEvent.change(await screen.findByLabelText(required?'查询词（必填）':'查询词'),{target:{value:''}});
 const cleared=JSON.parse((screen.getByLabelText('输入 JSON') as HTMLTextAreaElement).value);
 expect(cleared).toEqual({query:''});
 expect(validate(cleared)).toBe(false);
 expect(validate.errors?.map(error=>error.keyword)).toEqual(['minLength']);
});
