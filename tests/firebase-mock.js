// In-memory stand-in for the Firebase modules the app imports, so tests never touch the real database.
// Starts with a little sample data; state survives page reloads within a test via localStorage.
const S = window.__store = window.__store || JSON.parse(localStorage.getItem('__mock')||'null') || {transactions:{t1:{date:"2026-10-12",monthKey:"2026-10",direction:"out",value:23.5,pot:"dayToDay",category:"Food & Household",account:"Joint",paidBy:"Sonali",retailer:"Tesco"},t2:{date:"2026-10-02",monthKey:"2026-10",direction:"in",value:10,pot:"riyaan",category:"Clothes",account:"Hersh Credit",paidBy:"Hersh",retailer:"Next refund"}},budgets:{"2026-10":{dayToDay:650,riyaan:300}},annualBudgets:{"2026-04":{exceptionals:2000,holidays:6000}}};
const L=[]; let n=Date.now()%100000;
const persist=()=>{try{localStorage.setItem('__mock',JSON.stringify(S));}catch(e){}};
const fire=()=>{persist();L.forEach(f=>f());};
export const initializeApp=()=>({}), getAuth=()=>({}), getFirestore=()=>({}), initializeFirestore=()=>({}), persistentLocalCache=()=>({}), persistentMultipleTabManager=()=>({});
let authCb; export const onAuthStateChanged=(a,cb)=>{authCb=cb;}; export const signInAnonymously=async()=>{setTimeout(()=>authCb({uid:"u"}),10);};
export const collection=(db,c)=>({c});
export const doc=(a,c,id)=>c===undefined?{c:a.c,id:"auto"+(n++)}:{c,id};
export const serverTimestamp=()=>({seconds:Math.floor(Date.now()/1000)+(n++)});
const col=c=>(S[c]=S[c]||{});
const mset=(r,d,o)=>{col(r.c)[r.id]=o&&o.merge?deepMerge(col(r.c)[r.id]||{},d):d;};
function deepMerge(a,b){const o={...a};for(const k in b){o[k]=(b[k]&&typeof b[k]==='object'&&!Array.isArray(b[k])&&a[k]&&typeof a[k]==='object'&&!('seconds' in b[k]))?deepMerge(a[k],b[k]):b[k];}return o;}
export const addDoc=async(r,d)=>{const id="x"+(n++);col(r.c)[id]=d;fire();return {id};};
export const setDoc=async(r,d,o)=>{mset(r,d,o);fire();};
export const updateDoc=async(r,d)=>{col(r.c)[r.id]={...col(r.c)[r.id],...d};fire();};
export const deleteDoc=async r=>{delete col(r.c)[r.id];fire();};
export const getDoc=async r=>{const v=col(r.c)[r.id];return {exists:()=>!!v,data:()=>v};};
export const writeBatch=()=>{const ops=[],chk=[];return {set:(r,d,o)=>ops.push(()=>mset(r,d,o)),update:(r,d)=>{chk.push(r);ops.push(()=>{col(r.c)[r.id]={...col(r.c)[r.id],...d};});},delete:r=>ops.push(()=>{delete col(r.c)[r.id];}),commit:async()=>{if(window.__strict){const miss=chk.find(r=>!col(r.c)[r.id]);if(miss){fire();throw new Error('No document to update: projects/x/databases/(default)/documents/'+miss.c+'/'+miss.id);}}ops.forEach(f=>f());fire();}};};
export const onSnapshot=(r,cb)=>{const f=()=>{ if(r.id){const v=col(r.c)[r.id];cb({exists:()=>!!v,data:()=>v});} else cb({docs:Object.entries(col(r.c)).concat(Object.entries(((window.__ghosts||{})[r.c])||{})).map(([id,v])=>({id,data:()=>v}))}); };L.push(f);setTimeout(f,0);return ()=>{};};
