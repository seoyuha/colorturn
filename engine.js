/* COLOR TURN ENGLISH — 규칙 엔진 (브라우저와 서버가 같이 씀) */
const N=7, CELLS=49, CHIPS=12;
const rc=i=>[i/N|0,i%N];
/* 판: 위에서부터 A~G줄, 왼쪽부터 1~7칸. 파랑=맨 아래 G줄, 주황=맨 위 A줄, 초록=왼쪽 1칸 */
function homeCells(p){const a=[];for(let k=0;k<N;k++)a.push(p===0?(N-1)*N+k:p===1?k:k*N);return a}
const LINES=[];
for(let r=0;r<N;r++)for(let c=0;c<N;c++)for(const[dr,dc]of[[0,1],[1,0],[1,1],[1,-1]]){
  const L=[];for(let k=0;k<4;k++){const rr=r+dr*k,cc=c+dc*k;if(rr<0||rr>=N||cc<0||cc>=N)break;L.push(rr*N+cc)}
  if(L.length===4)LINES.push(L);
}
const NB={4:[],8:[]};
for(let i=0;i<CELLS;i++){const[r,c]=rc(i);NB[4][i]=[];NB[8][i]=[];
  for(let dr=-1;dr<=1;dr++)for(let dc=-1;dc<=1;dc++){if(!dr&&!dc)continue;const rr=r+dr,cc=c+dc;if(rr<0||rr>=N||cc<0||cc>=N)continue;
    NB[8][i].push(rr*N+cc);if(!dr||!dc)NB[4][i].push(rr*N+cc)}}
function legal(color,ids,p,lock,adj,left){
  const acts=[];
  if(!left||left[p]>0)for(const i of homeCells(p))if(color[i]<0)acts.push({t:"p",to:i});
  for(let i=0;i<CELLS;i++){if(color[i]<0||ids[i]===lock)continue;for(const n of NB[adj||4][i])if(color[n]<0)acts.push({t:"m",from:i,to:n})}
  return acts;
}
function isLegal(color,ids,p,lock,adj,left,a){return legal(color,ids,p,lock,adj,left).some(x=>x.t===a.t&&x.to===a.to&&(x.t==="p"||x.from===a.from))}
function sim(color,ids,a,p,mines,nextId,n){
  n=n||2;const c2=color.slice(),i2=ids.slice();let col,id;
  if(a.t==="p"){col=p;id=nextId}else{col=color[a.from];id=ids[a.from];c2[a.from]=-1;i2[a.from]=-1}
  const flipped=!!mines[a.to];c2[a.to]=flipped?(col+1)%n:col;i2[a.to]=id;
  return {c2,i2,id,flipped,oldColor:col,newColor:c2[a.to]};
}
function lineOf(color,col){for(const L of LINES){if(color[L[0]]===col&&color[L[1]]===col&&color[L[2]]===col&&color[L[3]]===col)return L}return null}
/* 행동한 사람이 먼저, 그다음은 차례 순서대로 4목 확인 */
function outcome(color,mover,n){n=n||2;for(let k=0;k<n;k++){const c=(mover+k)%n;if(lineOf(color,c))return c}return -1}
function makeMines(diff){const m=new Array(CELLS).fill(0);const k=(diff|0)+1;
  for(let r=0;r<N;r++){const cols=[...Array(N).keys()];for(let i=cols.length-1;i>0;i--){const j=Math.random()*(i+1)|0;[cols[i],cols[j]]=[cols[j],cols[i]]}cols.slice(0,k).forEach(c=>m[r*N+c]=1)}
  return m}
const PTS={correct:10,win:50,draw:20,play:5};
if(typeof module!=="undefined")module.exports={N,CELLS,CHIPS,rc,homeCells,LINES,NB,legal,isLegal,sim,lineOf,outcome,makeMines,PTS};
