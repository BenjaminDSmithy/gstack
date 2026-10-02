import { afterEach, expect, test } from 'bun:test';import * as fs from 'node:fs';import * as os from 'node:os';import * as path from 'node:path';import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
const dirs:string[]=[],children:ChildProcess[]=[];const tmp=()=>{const p=fs.mkdtempSync(path.join(os.tmpdir(),'csowatchdog-backoff-'));dirs.push(p);return p;};
afterEach(async()=>{for(const child of children.splice(0))if(child.exitCode===null&&child.signalCode===null){const closed=new Promise(resolve=>child.once('close',resolve));child.kill('SIGKILL');await closed;}for(const p of dirs.splice(0))fs.rmSync(p,{recursive:true,force:true,maxRetries:20,retryDelay:10});});
function compile(dir:string){const out=path.join(dir,'watchdog'),r=spawnSync('/usr/bin/cc',['-std=c11','-D_POSIX_C_SOURCE=200809L','-O2','-Wall','-Wextra',path.resolve(import.meta.dir,'../lib/cso/watchdog.c'),'-o',out],{encoding:'utf8',timeout:30_000});expect(r.stderr).toBe('');expect(r.status).toBe(0);return out;}
// Bind relative to cwd: macOS caps sun_path at 104 bytes and a free-runner shard's TMPDIR can push <dir>/daemon.sock past it. The watchdog only lstats the absolute path.
function bindSocket(dir:string){const made=spawnSync('/usr/bin/python3',['-c','import socket,sys; s=socket.socket(socket.AF_UNIX); s.bind(sys.argv[1]); s.close()','daemon.sock'],{cwd:dir,encoding:'utf8'});expect(made.stderr).toBe('');expect(made.status).toBe(0);const socket=path.join(dir,'daemon.sock'),stat=fs.lstatSync(socket);expect(stat.isSocket()).toBe(true);return{socket,device:stat.dev,inode:stat.ino};}
// `ps -o time=` prints [[dd-]hh:]mm:ss with centiseconds on macOS and whole seconds on Linux.
function cpuSeconds(pid:number){const r=spawnSync('ps',['-o','time=','-p',String(pid)],{encoding:'utf8'});expect(r.status).toBe(0);const value=r.stdout.trim(),[days,clock]=value.includes('-')?value.split('-'):['0',value];return Number(days)*86_400+clock.split(':').reduce((total,part)=>total*60+Number(part),0);}
async function until(done:()=>boolean,ms:number){for(const stop=Date.now()+ms;!done()&&Date.now()<stop;)await Bun.sleep(20);return done();}
test('a replaced Docker socket paces the blocked watchdog after its run dir is removed',async()=>{
  const root=tmp(),run=path.join(root,'run'),lease=path.join(root,'lease'),docker=path.join(root,'docker'),log=path.join(root,'docker.log'),token='a'.repeat(32);fs.mkdirSync(run);fs.mkdirSync(lease);fs.writeFileSync(path.join(lease,'lease.json'),'{}');fs.writeFileSync(path.join(lease,'lease.token'),token+'\n');fs.writeFileSync(docker,`#!/bin/sh\ntouch '${log}'\nexit 0\n`,{mode:0o755});
  const watchdog=compile(root),endpoint=bindSocket(run),owner=spawn('/bin/sleep',['30'],{stdio:'ignore'});children.push(owner);
  const child=spawn(watchdog,['--owner',String(owner.pid),'--deadline',String(Math.ceil((Date.now()+60_000)/1000)),'--run-dir',run,'--docker',docker,'--endpoint',`unix://${endpoint.socket}`,'--socket-device',String(endpoint.device),'--socket-inode',String(endpoint.inode),'--run-label','backoff','--lease-path',lease,'--lease-token',token],{stdio:'ignore'});children.push(child);
  expect(await until(()=>fs.existsSync(path.join(run,'watchdog.ready')),20_000)).toBe(true);
  fs.renameSync(endpoint.socket,`${endpoint.socket}.old`);expect(bindSocket(run).inode).not.toBe(endpoint.inode);const reaped=new Promise(resolve=>owner.once('exit',resolve));owner.kill('SIGKILL');await reaped;
  const event=path.join(run,'watchdog.event');expect(await until(()=>fs.existsSync(event)&&fs.readFileSync(event,'utf8').includes('socket identity changed'),20_000)).toBe(true);
  // A test's afterEach removing the run dir leaves the blocked watchdog with nothing to write, so a missing pause shows up as pure CPU.
  // Rename first: a spinning watchdog keeps recreating marker temps, and a plain rmSync of the live dir can return with it still present.
  fs.renameSync(run,`${run}.removed`);fs.rmSync(`${run}.removed`,{recursive:true,force:true});expect(fs.existsSync(run)).toBe(false);
  // At load 220-265 on 18 cores the unpaced loop still got 0.17-0.46 s of CPU per 3 s and the paced one 0.00 s, so the bound sits far below a starved spinner.
  const before=cpuSeconds(child.pid!);await Bun.sleep(5_000);const spent=cpuSeconds(child.pid!)-before;
  expect(child.exitCode).toBeNull();expect(child.signalCode).toBeNull();expect(spent).toBeLessThan(0.05);expect(fs.existsSync(path.join(lease,'lease.token'))).toBe(true);expect(fs.existsSync(log)).toBe(false);
},60_000);
