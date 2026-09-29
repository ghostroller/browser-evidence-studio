/** @vitest-environment jsdom */
import React,{useState} from 'react';
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,expect,test,vi} from 'vitest';
import {WorkflowInputs} from '@/renderer/components/workflow-inputs';
afterEach(()=>{cleanup();delete (window as Partial<Window>).studio;});
test('scalar forms retain numeric and boolean meaning and untouched advanced properties',async()=>{
 window.studio={bounds:vi.fn(),call:vi.fn(async()=>({schema:{type:'object',properties:{count:{type:'integer',title:'记录数'},enabled:{type:'boolean',title:'包含归档'}}}}))};
 function Form(){const [value,set]=useState('{"extra":{"keep":true}}');return <WorkflowInputs projectId="project" directory="registered" value={value} onChange={set}/>;}
 render(<Form/>);fireEvent.change(await screen.findByLabelText('记录数'),{target:{value:'2'}});fireEvent.change(screen.getByLabelText('包含归档'),{target:{value:'false'}});
 expect(JSON.parse((screen.getByLabelText('输入 JSON') as HTMLTextAreaElement).value)).toEqual({extra:{keep:true},count:2,enabled:false});
 fireEvent.change(screen.getByLabelText('记录数'),{target:{value:''}});expect(JSON.parse((screen.getByLabelText('输入 JSON') as HTMLTextAreaElement).value)).not.toHaveProperty('count');
});
test('late schemas cannot replace the new project and unsupported schemas preserve JSON',async()=>{
 let finish!:(value:any)=>void;const old=new Promise(resolve=>{finish=resolve;});window.studio={bounds:vi.fn(),call:vi.fn(async(_method,body:any)=>body.projectId==='old'?old:{schema:{type:'object',properties:{nested:{type:'object'}}}})};
 const view=render(<WorkflowInputs projectId="old" directory="a" value="{}" onChange={vi.fn()}/>);view.rerender(<WorkflowInputs projectId="new" directory="b" value="{}" onChange={vi.fn()}/>);
 finish({schema:{type:'object',properties:{bad:{type:'string',title:'Late field'}}}});await waitFor(()=>expect(screen.queryByLabelText('Late field')).toBeNull());expect(screen.getByLabelText('输入 JSON')).toBeTruthy();
});
