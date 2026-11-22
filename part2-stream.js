"use strict";
// TOEIC Part 2 realtime transcription over a dedicated WebRTC data channel.
// This module never requests microphone permissions: it reuses liveStream's active track.
// No permanent OpenAI API key enters the browser.
let part2StreamPc=null,part2StreamDc=null,part2StreamActive=false;
let part2StreamEpoch=0,part2StreamSolveBusy=false,part2StreamSolveAgain=false;
let part2StreamRecentChecked="",part2StreamRecentAt=0;
let part2EarlyBusy=false,part2EarlyFingerprint="",part2EarlyCheckedAt=0;
let part2StreamFirstUntranscribedSpeechAt=0,part2StreamWatchdog=null;
function part2StreamNoteMic(rms){
 if(!part2StreamActive)return;
 if(rms>0.011&&!part2StreamFirstUntranscribedSpeechAt)
  part2StreamFirstUntranscribedSpeechAt=performance.now();
}
const part2StreamItems=new Map();
let part2StreamOrder=[];
function part2StreamStatus(message){
 const node=document.getElementById("part2RealtimeState");
 if(node)node.textContent=message;
}
function part2StopRealtimeStream(reason="stopped"){
 ++part2StreamEpoch;
 part2StreamActive=false;part2StreamSolveBusy=false;part2StreamSolveAgain=false;
 part2StreamItems.clear();part2StreamOrder=[];
 part2StreamRecentChecked="";
 part2EarlyBusy=false;part2EarlyFingerprint="";part2EarlyCheckedAt=0;
 part2StreamFirstUntranscribedSpeechAt=0;
 clearInterval(part2StreamWatchdog);part2StreamWatchdog=null;
 const dc=part2StreamDc,pc=part2StreamPc;
 part2StreamDc=null;part2StreamPc=null;
 try{dc?.close()}catch{}
 try{pc?.close()}catch{}
 if(reason==="stopped")part2StreamStatus("스트리밍 종료");
}
function part2StreamFallback(reason){
 if(!liveRunning||!part2Mode||!part2StreamPc)return;
 part2Trace("스트리밍 복구",part2ExpectedNumber,reason);
 part2StopRealtimeStream("fallback");
 part2StreamStatus("스트리밍 중단 · 기존 AI 분석으로 자동 복구 · "+reason);
 if(liveFrameCount>liveRate*14)part2KeepRecentAudio();
 part2PreviewAt=0;
}
function part2StreamJoinedText(){
 const parts=[];
 for(const id of part2StreamOrder){
  const row=part2StreamItems.get(id);
  if(!row)continue;
  const text=String(row.final??row.partial??"").trim();
  if(text)parts.push(text);
 }
 return parts.join(" ").replace(/\s+/g," ").trim().slice(-6000);
}
function part2StreamCandidate(number){
 let text=part2StreamJoinedText();
 const nums={one:1,two:2,three:3,four:4,five:5,six:6,seven:7,eight:8,nine:9,ten:10,
  eleven:11,twelve:12,thirteen:13,fourteen:14,fifteen:15,sixteen:16,seventeen:17,
  eighteen:18,nineteen:19,twenty:20};
 text=text.replace(/\b(Number|Question)\s+(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)\b/gi,
  (_,prefix,word)=>prefix+" "+nums[word.toLowerCase()]);
 const marks=[...text.matchAll(/\b(?:number|question)\s+(\d{1,3})\b/gi)];
 const matching=marks.filter(m=>Number(m[1])===number).at(-1);
 if(matching){
  const next=marks.find(m=>(m.index??0)>(matching.index??0)&&Number(m[1])!==number);
  return text.slice(matching.index??0,next?.index??text.length).trim();
 }
 if(marks.length)return "";
 const q=text.match(/\b(?:who|what|which|whose|where|when|why|how|should|would|could|can|did|does|do|is|are|was|were|will|have|has)\b/i);
 return q?text.slice(q.index??0).trim():"";
}
function part2StreamMaybeEarlySolve(){
 if(!part2StreamActive||!liveRunning||!part2Mode||part2EarlyBusy)return;
 const number=part2ExpectedNumber;
 if(part2AnnouncedNumbers.has(number))return;
 const item=part2StreamCandidate(number);
 if(!item||item.length<45)return;
 const marks=[...item.matchAll(/(?:^|\s)([ABC])[.)](?=\s)/gi)];
 const markers=marks.map(m=>m[1].toUpperCase()).join("");
 let question="",a="",b="";
 if(markers==="AB"){
  question=item.slice(0,marks[0].index).trim();
  a=item.slice((marks[0].index??0)+marks[0][0].length,marks[1].index).trim();
  b=item.slice((marks[1].index??0)+marks[1][0].length).trim();
 }else if(!markers){
  // Some TOEIC recordings omit spoken A/B labels. Use the three
  // completed sentences: question, first reply, second reply.
  const clean=item.replace(/^(?:number|question)\s+\d{1,3}[.:]?\s*/i,"");
  const sentences=(clean.match(/[^.!?]+[.!?]+/g)||[]).map(x=>x.trim());
  if(sentences.length!==3||clean.replace(/[^.!?]+[.!?]+/g,"").trim())return;
  [question,a,b]=sentences;
 }else return;
 if(!question.includes("?")||question.split(/\s+/).length<4
    ||a.split(/\s+/).length<2||b.split(/\s+/).length<2
    ||!/[.!?]$/.test(a)||!/[.!?]$/.test(b))return;
 const prepared="Number "+number+". "+question+" A. "+a+" B. "+b;
 const fingerprint=number+"|"+item;
 if(fingerprint===part2EarlyFingerprint&&performance.now()-part2EarlyCheckedAt<8000)return;
 part2EarlyFingerprint=fingerprint;part2EarlyCheckedAt=performance.now();
 part2EarlyBusy=true;
 const epoch=part2StreamEpoch,abort=new AbortController(),timer=setTimeout(()=>abort.abort(),7500);
 void (async()=>{
  try{
   part2Trace("A·B 소거법 검토",number);
   const response=await authed(API+"?action=early-eliminate-part2",{
    method:"POST",headers:{"Content-Type":"application/json"},
    body:JSON.stringify({number,transcript:prepared.slice(0,3300)}),signal:abort.signal
   });
   if(!response.ok)return;
   const result=await response.json();
   if(epoch!==part2StreamEpoch||!part2StreamActive||!liveRunning||!part2Mode
      ||number!==part2ExpectedNumber||part2AnnouncedNumbers.has(number))return;
   // If C has begun while the early verdict was in flight, await the full solver.
   const latest=part2StreamCandidate(number);
   // Any transcript change, including the beginning of an unlabelled C,
   // invalidates this early decision.
   if(latest!==item)return;
   if(result.ready===true&&result.answer==="C"&&Number(result.question_number)===number){
    const fp=part2QuestionFingerprint(item);
    const previous=part2QuestionFingerprints.get(number-1);
    if(previous&&part2QuestionRepeated(fp,previous))return;
    part2AnnouncedNumbers.add(number);
    if(fp)part2QuestionFingerprints.set(number,fp);
    const spoken=number+"번 C";
    queuePart2Audio("preview-stream-early-"+liveSessionId+"-"+number,spoken);
    part2ExpectedNumber=number+1;
    part2Trace("A·B 소거법 C 조기 확정",number,spoken);
    void preparePart2AnswerClips(number+1);
    part2StreamStatus("A·B 소거법 조기 확정 · "+spoken+" · 다음 문제 계속 수음");
    liveMessage(spoken+" · A·B 소거법으로 조기 판단");
    part2StreamRecentChecked="";
   }
  }catch(error){
   if(epoch===part2StreamEpoch)part2Trace("A·B 소거법 대기",number,String(error).slice(0,60));
  }finally{
   clearTimeout(timer);
   if(epoch===part2StreamEpoch)part2EarlyBusy=false;
  }
 })();
}
function part2StreamMaybeSolve(){
 if(!part2StreamActive||!liveRunning||!part2Mode)return;
 if(part2StreamSolveBusy){part2StreamSolveAgain=true;return}
 const number=part2ExpectedNumber;
 if(part2AnnouncedNumbers.has(number))return;
 const item=part2StreamCandidate(number);
 if(!item||item.length<40)return;
 const withoutNumber=item.replace(/^(?:number|question)\s+\d{1,3}[.:]?\s*/i,"");
 const sentences=(withoutNumber.match(/[.!?](?=\s|$)/g)||[]).length;
 const labels=[...withoutNumber.matchAll(/(?:^|\s)([ABC])[.)](?=\s)/gi)]
   .map(m=>m[1].toUpperCase()).join("");
 // Do not send a solver request at B just because the question number
 // counts as an extra sentence.
 if(labels&&labels!=="ABC")return;
 if(!/[.!?]\s*$/.test(withoutNumber))return;
 if((labels==="ABC"&&sentences<4)||(!labels&&sentences<4))return;
 const fingerprint=number+"|"+item.slice(-1200);
 if(fingerprint===part2StreamRecentChecked&&performance.now()-part2StreamRecentAt<2500)return;
 part2StreamRecentChecked=fingerprint;part2StreamRecentAt=performance.now();
 part2StreamSolveBusy=true;part2StreamSolveAgain=false;
 const epoch=part2StreamEpoch,abort=new AbortController();
 const timeout=setTimeout(()=>abort.abort(),9000);
 void (async()=>{
  try{
   part2StreamStatus("실시간 스트리밍 연결됨 · "+number+"번 정답 판정 중");
   const response=await authed(API+"?action=solve-part2-text",{
    method:"POST",headers:{"Content-Type":"application/json"},
    body:JSON.stringify({number,transcript:item.slice(0,3300)}),signal:abort.signal
   });
   const result=await response.json();
   if(epoch!==part2StreamEpoch||!part2StreamActive||!liveRunning||!part2Mode)return;
   if(!response.ok)throw Error(result.error||"HTTP "+response.status);
   if(result.complete&&Number(result.question_number)===number
      &&/^[ABC]$/.test(result.answer||"")&&!part2AnnouncedNumbers.has(number)){
    const fp=part2QuestionFingerprint(result.transcript);
    const previous=part2QuestionFingerprints.get(number-1);
    if(previous&&part2QuestionRepeated(fp,previous)){
     part2Trace("이전 질문 중복 거절",number);return;
    }
    part2AnnouncedNumbers.add(number);
    if(fp)part2QuestionFingerprints.set(number,fp);
    const spoken=number+"번 "+result.answer;
    queuePart2Audio("preview-stream-"+liveSessionId+"-"+number,spoken);
    part2ExpectedNumber=number+1;
    part2Trace("스트리밍 정답 확정",number,spoken);
    void preparePart2AnswerClips(number+1);
    part2StreamStatus("스트리밍 정상 · "+spoken+" 안내 · "+(number+1)+"번 듣는 중");
    liveMessage(spoken+" · 다음 문제 분석은 계속 진행");
    part2StreamRecentChecked="";
   }
  }catch(error){
   if(epoch===part2StreamEpoch){
    part2Trace("스트리밍 정답 오류",number,String(error));
    part2StreamStatus("영어 인식 유지 · 정답 판정 지연: "+String(error).slice(0,100));
   }
  }finally{
   clearTimeout(timeout);
   if(epoch===part2StreamEpoch){
    part2StreamSolveBusy=false;
    if(part2StreamSolveAgain||number!==part2ExpectedNumber)
     setTimeout(()=>part2StreamMaybeSolve(),80);
   }
  }
 })();
}
function part2StreamReceive(event){
 if(!part2StreamActive)return;
 if(event.type==="input_audio_buffer.committed"){
  const id=String(event.item_id||"");
  if(id&&!part2StreamItems.has(id)){
   part2StreamItems.set(id,{partial:"",final:null});
   const previous=String(event.previous_item_id||"");
   const index=part2StreamOrder.indexOf(previous);
   if(index>=0)part2StreamOrder.splice(index+1,0,id);
   else part2StreamOrder.push(id);
  }
  return;
 }
 if(event.type==="error"){
  part2Trace("스트리밍 서버 오류",part2ExpectedNumber,event.error?.message||"unknown");
  part2StreamFallback("서버 오류");return;
 }
 if(event.type!=="conversation.item.input_audio_transcription.delta"
  &&event.type!=="conversation.item.input_audio_transcription.completed")return;
 part2StreamFirstUntranscribedSpeechAt=0;
 const id=String(event.item_id||"");
 if(!id)return;
 let row=part2StreamItems.get(id);
 if(!row){row={partial:"",final:null};part2StreamItems.set(id,row);part2StreamOrder.push(id)}
 if(event.type.endsWith(".delta")){
  row.partial+=String(event.delta||"");
  if(row.partial.length>1800)row.partial=row.partial.slice(-1800);
 }else{
  row.final=String(event.transcript||"");
  part2Trace("실시간 발화 인식",part2ExpectedNumber,"문자 "+row.final.length);
 }
 if(part2StreamOrder.length>38){
  for(const old of part2StreamOrder.splice(0,part2StreamOrder.length-28))
   part2StreamItems.delete(old);
 }
 part2StreamMaybeSolve();
}
async function startPart2RealtimeStream(){
 if(!liveRunning||!part2Mode||!document.getElementById("part2UseRealtime")?.checked||!liveStream)return;
 const epoch=++part2StreamEpoch;
 part2StreamStatus("실시간 스트리밍 연결 중 · 기존 분석은 계속");
 let pc;
 try{
  if(!window.RTCPeerConnection)throw Error("WebRTC 미지원");
  pc=new RTCPeerConnection();part2StreamPc=pc;
  const track=liveStream.getAudioTracks()[0];
  if(!track||track.readyState!=="live")throw Error("마이크 연결 없음");
  pc.addTrack(track,liveStream);
  const dc=pc.createDataChannel("oai-events");
  part2StreamDc=dc;
  dc.addEventListener("message",e=>{
   try{part2StreamReceive(JSON.parse(e.data))}
   catch(error){part2Trace("스트리밍 메시지 오류",part2ExpectedNumber,String(error))}
  });
  dc.addEventListener("close",()=>{
   if(epoch===part2StreamEpoch&&part2StreamActive)part2StreamFallback("데이터 채널 종료");
  });
  pc.onconnectionstatechange=()=>{
   if(epoch===part2StreamEpoch&&part2StreamActive
    &&["failed","disconnected","closed"].includes(pc.connectionState))
    part2StreamFallback("WebRTC "+pc.connectionState);
  };
  const offer=await pc.createOffer();
  await pc.setLocalDescription(offer);
  const abort=new AbortController(),timer=setTimeout(()=>abort.abort(),14000);
  let answer;
  try{
   const response=await authed(API+"?action=stream-connect",{
    method:"POST",headers:{"Content-Type":"application/json"},
    body:JSON.stringify({sdp:offer.sdp}),signal:abort.signal
   });
   if(!response.ok){
    const error=await response.json().catch(()=>({}));
    throw Error(error.error||"연결 HTTP "+response.status);
   }
   answer=await response.text();
  }finally{clearTimeout(timer)}
  if(epoch!==part2StreamEpoch||!liveRunning){try{pc.close()}catch{};return}
  await pc.setRemoteDescription({type:"answer",sdp:answer});
  await Promise.race([
   new Promise((resolve,reject)=>{
    if(dc.readyState==="open")return resolve(null);
    dc.addEventListener("open",resolve,{once:true});
    dc.addEventListener("error",()=>reject(Error("데이터 채널 오류")),{once:true});
   }),
   new Promise((_,reject)=>setTimeout(()=>reject(Error("WebRTC 연결 시간 초과")),6500))
  ]);
  if(epoch!==part2StreamEpoch||!liveRunning||!part2Mode)return;
  part2StreamActive=true;part2StreamItems.clear();part2StreamOrder=[];
  part2StreamFirstUntranscribedSpeechAt=0;
  clearInterval(part2StreamWatchdog);
  part2StreamWatchdog=setInterval(()=>{
   if(!part2StreamActive||!liveRunning)return;
   if(part2StreamFirstUntranscribedSpeechAt&&
      performance.now()-part2StreamFirstUntranscribedSpeechAt>12500)
    part2StreamFallback("영어 수음 대비 전사 결과 지연 12초");
   part2StreamMaybeEarlySolve();
   part2StreamMaybeSolve();
  },1000);
  part2Trace("스트리밍 연결 성공",part2ExpectedNumber);
  part2StreamStatus("실시간 스트리밍 연결됨 · 정답만 음성 안내 · 연속 수음");
 }catch(error){
  if(epoch!==part2StreamEpoch)return;
  part2Trace("스트리밍 연결 실패",part2ExpectedNumber,String(error));
  part2StreamFallback(String(error).slice(0,110));
 }
}
