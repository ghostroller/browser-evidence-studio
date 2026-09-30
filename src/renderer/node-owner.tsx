import React from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';
import { NodeOwner } from './components/node-owner';

const instanceId = document.querySelector<HTMLMetaElement>('meta[name="workbench-instance"]')?.content;
createRoot(document.getElementById('root')!).render(instanceId
  ? <NodeOwner instanceId={instanceId}/>
  : <main role="alert">Node 控制台缺少实例身份，请使用启动器提供的地址。</main>);
