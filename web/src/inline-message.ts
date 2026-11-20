import {managedImageURL,type ScreenshotInput} from './managed-codex.ts';

export const MAX_INLINE_IMAGES = 3;
export type InlineDraftPart = {text:string}|{image:ScreenshotInput};
export type InlineSavedPart = {text:string}|{image_url:string};
export const inlineText = (parts: readonly InlineDraftPart[]) => parts.map(part=>'text' in part ? part.text : '').join('');
export const inlineImageCount = (parts: readonly InlineDraftPart[]) => parts.filter(part=>'image' in part).length;

export function scopedInlineParts(taskID:string, value:unknown):InlineSavedPart[]|undefined {
 if(!Array.isArray(value)||!value.length)return undefined;
 const parts:InlineSavedPart[]=[];
 for (const input of value) {
  if(!input || typeof input!=='object')return undefined;
  if(typeof input.text==='string' && !('image_url' in input)) parts.push({text:input.text});
  else {
   const url=managedImageURL(taskID,input.image_url);
   if(!url || 'text' in input)return undefined;
   parts.push({image_url:url});
  }
 }
 return parts;
}
