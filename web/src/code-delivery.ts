import { currentReadyReportID, evidenceExcerpt, evidenceLink, type Task } from './model.ts';

export type CodeReviewLink={kind:'MR'|'CR'|'PR';number:string;url:string};
export type CodeDelivery={links:CodeReviewLink[];localPatch:boolean};

// Recognize review routes, not arbitrary reported URLs. Drop query/fragment
// decoration so copied access tokens and duplicate diff views are not surfaced.
// This is a reporter-supplied reference, never a remote status verification.
export function codeReviewLink(raw:string):CodeReviewLink|undefined {
 if(!/^https?:\/\//i.test(raw)||/[\s\\\u0000-\u001f\u007f]/.test(raw))return;
 try {
  const url=new URL(raw);
  if(!['http:','https:'].includes(url.protocol)||!url.hostname||url.username||url.password)return;
  const path=url.pathname;
  let match=/^(.+\/-\/merge_requests\/([1-9]\d*))(?:\/(?:diffs|commits|pipelines))?\/?$/.exec(path);
  let kind:CodeReviewLink['kind']='MR';
  if(!match&&url.host==='github.com'){match=/^(\/[^/]+\/[^/]+\/pull\/([1-9]\d*))(?:\/(?:files|commits|checks))?\/?$/.exec(path);kind='PR'}
  if(!match){match=/^(.*\/c\/(?:[^/]+\/)+\+\/([1-9]\d*))(?:\/[1-9]\d*(?:\/[^?#]*)?)?\/?$/.exec(path);kind='CR'}
  if(match){url.pathname=match[1];url.search='';url.hash='';return {kind,number:match[2],url:url.href}}
  // Gerrit's legacy hash router uses /#/c/NUMBER, optionally a patch set.
  const legacy=/^#\/c\/([1-9]\d*)(?:\/[1-9]\d*)?\/?$/.exec(url.hash);
  if(legacy&&(path==='/'||path==='/gerrit/')){url.search='';url.hash='/c/'+legacy[1];return {kind:'CR',number:legacy[1],url:url.href}}
 }catch{/* unrecognized references stay in the ordinary evidence section */}
}

function textURLs(text:string):string[] {
 return (text.match(/(?<![A-Za-z0-9_:/@])https?:\/\/[^\s<>"'`]+/gi)||[]).map(raw=>raw.replace(/[.,;:!?，。；！？)\]}]+$/g,''));
}

export function codeDelivery(task:Task):CodeDelivery {
 const result:CodeDelivery={links:[],localPatch:false};
 // Reuse the current ready report gate. Old attempts, superseded snapshots,
 // goals, summaries and non-ready claims are not delivery-link authorities.
 if(!currentReadyReportID(task))return result;
 const seen=new Set<string>();
 for(const entry of task.evidence||[]){
  const explicitLabel=entry.label?.trim().toLowerCase();
  if((explicitLabel==='本地补丁'||explicitLabel==='local patch')&&(evidenceExcerpt(entry)||evidenceLink(entry)))result.localPatch=true;
  const candidates=[...(entry.url?[entry.url.trim()]:[]),...textURLs(entry.label||''),...textURLs(entry.excerpt||'')];
  for(const candidate of candidates){
   const link=codeReviewLink(candidate);
   if(link&&!seen.has(link.url)){seen.add(link.url);result.links.push(link)}
  }
 }
 return result;
}
