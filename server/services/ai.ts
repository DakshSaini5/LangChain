import { z } from 'zod';

const endpoint='https://generativelanguage.googleapis.com/v1beta/models';
const translationSchema=z.object({segments:z.array(z.object({id:z.string(),translation:z.string().min(1)})).min(1)});
export type TranslationSegment = {
  id: string;
  kind: 'heading' | 'paragraph' | 'list-item' | 'table-cell' | 'line';
  text: string;
  separator: string;
  page?: number;
  row?: number;
  column?: number;
  level?: number;
};
type TranslationUnit=TranslationSegment&{sourceId:string;unchanged:boolean};
const translationResponseSchema={type:'OBJECT',properties:{segments:{type:'ARRAY',items:{type:'OBJECT',properties:{id:{type:'STRING'},translation:{type:'STRING'}},required:['id','translation']}}},required:['segments']};

function splitLongBlock(text:string,limit:number){
  const pieces:string[]=[];let remaining=text;
  while(remaining.length>limit){
    const window=remaining.slice(0,limit);let cut=-1;
    for(const match of window.matchAll(/[.!?。！？;:]\s+/g))cut=match.index!+match[0].length;
    if(cut<Math.floor(limit*.5))cut=window.lastIndexOf(' ');
    if(cut<Math.floor(limit*.5))cut=limit;
    pieces.push(remaining.slice(0,cut));remaining=remaining.slice(cut);
  }
  if(remaining)pieces.push(remaining);return pieces;
}

function makeTranslationBatches(text:string,limit=4200):TranslationSegment[][]{
  const parts=text.trim().split(/(\r?\n+)/);const blocks:{text:string;separator:string}[]=[];
  for(let i=0;i<parts.length;i+=2){const value=parts[i]||'';const separator=parts[i+1]||'';if(value.trim())blocks.push({text:value,separator});else if(blocks.length)blocks[blocks.length-1].separator+=value+separator;}
  const segments:TranslationSegment[]=[];let index=0;
  for(const block of blocks){
    const pieces=block.text.length>limit?splitLongBlock(block.text,limit):[block.text];
    for(let i=0;i<pieces.length;i++)segments.push({id:`p${++index}`,kind:'paragraph',text:pieces[i],separator:i===pieces.length-1?block.separator:''});
  }
  if(!segments.length)throw new Error('There is no translatable text in this document.');
  const batches:TranslationSegment[][]=[];let batch:TranslationSegment[]=[];let size=0;
  for(const segment of segments){if(batch.length&&size+segment.text.length>limit){batches.push(batch);batch=[];size=0}batch.push(segment);size+=segment.text.length;}
  if(batch.length)batches.push(batch);return batches;
}
export function prepareTranslationSegments(text: string): TranslationSegment[] {
  return makeTranslationBatches(text).flat();
}
const FALLBACK_MODELS = ['gemini-flash-lite-latest', 'gemini-3.5-flash'];

function resolveModels(preferred: string) {
  return [...new Set([preferred, ...FALLBACK_MODELS])].slice(0, 3);
}

async function generate(prompt: string, options: { systemInstruction?: string; responseSchema?: Record<string, unknown> } = {}) {
  const env = (globalThis as typeof globalThis & { process?: { env?: Record<string, string | undefined> } }).process?.env;
  const key = env?.GEMINI_API_KEY;
  if (!key) throw new Error('Translation service is not configured. Add GEMINI_API_KEY to the server environment.');

  const preferred = (env?.GEMINI_MODEL || 'gemini-3.5-flash-lite').trim();
  const models = resolveModels(preferred);
  const budgetMs = Number(env?.GEMINI_TIMEOUT_MS || 150000);
  const deadline = Date.now() + (Number.isFinite(budgetMs) && budgetMs > 10000 ? budgetMs : 150000);
  let lastError = 'Gemini could not complete this request. Your text is unchanged; please retry.';

  for (const model of models) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (Date.now() >= deadline) break;

      const generationConfig = options.responseSchema
        ? { responseMimeType: 'application/json', responseSchema: options.responseSchema }
        : undefined;

      let response: Response;
      try {
        response = await fetch(
          `${endpoint}/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              ...(options.systemInstruction
                ? { systemInstruction: { parts: [{ text: options.systemInstruction }] } }
                : {}),
              contents: [{ role: 'user', parts: [{ text: prompt }] }],
              ...(generationConfig ? { generationConfig } : {}),
            }),
            signal: AbortSignal.timeout(Math.min(45000, Math.max(5000, deadline - Date.now()))),
          },
        );
      } catch (error) {
        if (error instanceof Error && error.name === 'TimeoutError') {
          lastError = 'Gemini took too long to respond. Your text is unchanged; please retry.';
          console.warn(`Gemini model ${model} timed out, trying the next model.`);
          break;
        }
        throw error;
      }

      if (response.ok) {
        const payload = await response.json() as {
          candidates?: { content?: { parts?: { text?: string }[] } }[];
        };
        const text = payload.candidates?.[0]?.content?.parts
          ?.map(part => part.text || '')
          .join('')
          .trim();
        if (!text) {
          throw new Error('Gemini returned an empty result. Your original is safe; please retry.');
        }
        return text;
      }

      const detail = await response.text();
      console.error('Gemini request failed', response.status, model, detail.slice(0, 300));

      if (response.status === 401 || response.status === 403) {
        throw new Error('Gemini rejected the configured API key. Check the server configuration.');
      }

      if (response.status === 404) {
        lastError = 'The configured Gemini model is not available for this key. Check GEMINI_MODEL on the server.';
        break;
      }

      if (response.status === 503 || response.status === 429 || response.status === 500) {
        lastError = response.status === 429
          ? 'Gemini is rate limiting requests. Your text is unchanged; wait a moment and retry.'
          : 'Gemini is temporarily busy. Your text is unchanged; wait a moment and retry.';
        await new Promise(resolve => setTimeout(resolve, 1200));
        continue;
      }

      throw new Error('Gemini could not complete this request. Your original is unchanged; please retry.');
    }
    if (Date.now() >= deadline) break;
    console.warn(`Gemini model ${model} unavailable, trying the next model.`);
  }

  throw new Error(lastError);
}

function splitLeadingNumber(text: string) {
  const match = text.match(
    /^(\s*\d+(?:\.\d+)*(?:[.)])?)(\s+)([\s\S]*)$/
  );

  if (!match) {
    return { prefix: "", spacing: "", body: text };
  }

  return {
    prefix: match[1],
    spacing: match[2],
    body: match[3],
  };
}

function protectInline(text:string){
  const kept:string[]=[];
  const protectedText=text.replace(/https?:\/\/[^\s]+|[\w.+-]+@[\w-]+\.[\w.-]+/g,(match)=>{
    const link=match.replace(/[.,;:!?)\]]+$/,'');
    const trailing=match.slice(link.length);
    kept.push(link);
    return `ZXQKEEP${kept.length-1}QXZ${trailing}`;
  });
  return {text:protectedText,kept};
}

function restoreInline(text:string,kept:string[]){
  let value=text;
  const missing:string[]=[];
  kept.forEach((link,index)=>{
    const pattern=new RegExp(`Z\\s*X\\s*Q\\s*K\\s*E\\s*E\\s*P\\s*${index}\\s*Q\\s*X\\s*Z`,'gi');
    const next=value.replace(pattern,()=>link);
    if(next===value)missing.push(link);
    else value=next;
  });
  return {text:value,missing};
}

export async function translateText(input:{text:string;segments?:TranslationSegment[];glossary?:{source:string;target:string}[];source:'English'|'Hindi';target:'English'|'Hindi';mode?:string}){
  if(input.source===input.target)throw new Error('Choose different source and target languages.');
  const env=(globalThis as typeof globalThis & {process?:{env?:Record<string,string|undefined>}}).process?.env;
  const translationUrl=(env?.TRANSLATION_SERVICE_URL||'http://127.0.0.1:8001').replace(/\/$/,'');
  const sourceSegments=input.segments?.length?input.segments:makeTranslationBatches(input.text).flat();
  if(new Set(sourceSegments.map(segment=>segment.id)).size!==sourceSegments.length)throw new Error('The extracted document contains duplicate passage IDs. Re-open the document before translating.');

  // Keep numeric-only passages unchanged and translate the rest in bounded batches.
  const allUnits:TranslationUnit[]=sourceSegments.flatMap(segment=>{
    if(!segment.text.trim())return[{...segment,sourceId:segment.id,unchanged:true}];
    const pieces=segment.text.length>4200?splitLongBlock(segment.text,4200):[segment.text];
    return pieces.map((piece,index)=>({id:pieces.length===1?segment.id:`${segment.id}.${index+1}`,sourceId:segment.id,kind:segment.kind,text:piece,separator:index===pieces.length-1?segment.separator:'',...(segment.page?{page:segment.page}:{}),...(segment.row!==undefined?{row:segment.row}:{}),...(segment.column!==undefined?{column:segment.column}:{}),...(segment.level?{level:segment.level}:{}),unchanged:/^(?:[$€£₹]\s*)?[\d,]+(?:\.\d+)?(?:\s?%|\s?[A-Za-z]{1,10})?$/.test(piece.trim())}));
  });
  const keptInline=new Map<string,string[]>();
  for(const unit of allUnits){
    if(unit.unchanged)continue;
    const protectedUnit=protectInline(unit.text);
    if(protectedUnit.kept.length){keptInline.set(unit.id,protectedUnit.kept);unit.text=protectedUnit.text;}
  }
  const translated=new Map<string,string>();
  for(const unit of allUnits)if(unit.unchanged)translated.set(unit.id,unit.text);
  const batches:TranslationUnit[][]=[];let current:TranslationUnit[]=[];let batchSize=0;
  for(const unit of allUnits){if(unit.unchanged)continue;if(current.length&&batchSize+unit.text.length>3000){batches.push(current);current=[];batchSize=0;}current.push(unit);batchSize+=unit.text.length;}
  if(current.length)batches.push(current);

  for(let batchIndex=0;batchIndex<batches.length;batchIndex++){
    const batch=batches[batchIndex];
    let response:Response;
    try{
      response=await fetch(`${translationUrl}/translate`,{
        method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({source:input.source,target:input.target,
        glossary: input.glossary ?? [],
        segments: batch.map(unit => {
          const { body } = splitLeadingNumber(unit.text);

          return {
            id: unit.id,
            text: body,
          };
        }),
        }),
        signal:AbortSignal.timeout(180000),
      });
    }
    catch(error){
      if(error instanceof Error&&(error.name==='TimeoutError'||error.name==='AbortError'))throw new Error('The translation model took too long to respond. Your original is unchanged; retry a smaller section.');
      throw new Error('Cannot reach the local translation model. Start the GPU translation service and check TRANSLATION_SERVICE_URL.');
    }
    if(!response.ok){const detail=await response.text().catch(()=> '');console.error('Translation service error',response.status,detail.slice(0,300));throw new Error(response.status===503?'The translation model is still loading or unavailable. Wait a moment and retry.':`Translation service returned HTTP ${response.status}. Check the translation service logs.`);}
    const payload=await response.json() as {segments?:{id:string;translation:string}[]};
    if(!Array.isArray(payload.segments))throw new Error('Translation service returned an invalid response. Your original is unchanged.');
    const expected=new Set(batch.map(unit=>unit.id));
    for(const item of payload.segments){
      if(typeof item.id!=='string'||typeof item.translation!=='string'||!item.translation.trim()||!expected.delete(item.id))throw new Error('Translation quality check failed: the model returned a missing, duplicate, or invalid passage. No translation was applied.');
      
      const originalUnit = batch.find(unit => unit.id === item.id)!;
      const { prefix, spacing } = splitLeadingNumber(originalUnit.text);

      translated.set(
        item.id,
        prefix
          ? prefix + spacing + item.translation.trimStart()
          : item.translation
      );

    }
   
if (expected.size) {
  throw new Error(
    `Translation quality check failed: ${expected.size} passage(s) were missing. No translation was applied.`
  );
}

const normalizeDigits = (value: string) =>
  value
    .replace(/[०-९]/g, digit => String("०१२३४५६७८९".indexOf(digit)))
    .replace(/[٠-٩]/g, digit => String("٠١٢٣٤٥٦٧٨٩".indexOf(digit)));

const extractNumbers = (value: string) =>
  normalizeDigits(value).match(/\d+(?:[.,]\d+)*/g)?.map(number => {
    const normalized = number.replace(/,/g, "");
    if (!normalized.includes(".")) return normalized;
    return normalized.replace(/0+$/, "").replace(/\.$/, "");
  }) ?? [];

const extractLinks = (value: string) =>
  value.match(/https?:\/\/[^\s<>]+|[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g) ?? [];

for (const unit of batch) {
  const targetText = translated.get(unit.id)!;
  
  const normalizeHeadingNumbers = (value: string) =>
    value.replace(
      /^(\s*\d+(?:\.\s*\d+)+)(?=\s)/gm,
      heading => heading.replace(/\s+/g, "")
    );

  const sourceNumbers = extractNumbers(
  normalizeHeadingNumbers(unit.text)
  );
  const targetNumbers = extractNumbers(
    normalizeHeadingNumbers(targetText)
  );

  const sourceLinks = extractLinks(unit.text);
  const targetLinks = extractLinks(targetText);

  const sameTokens = (left: string[], right: string[]) => {
    if (left.length !== right.length) return false;
    const a = [...left].sort().join('|');
    const b = [...right].sort().join('|');
    return a === b;
  };

  if (!sameTokens(sourceNumbers, targetNumbers) || !sameTokens(sourceLinks, targetLinks)) {
    console.log("QUALITY CHECK DEBUG:", {
      passage: unit.id,
      source: unit.text,
      translation: targetText,
      sourceNumbers,
      targetNumbers,
      sourceLinks,
      targetLinks,
    });
    throw new Error(
      `Translation quality check flagged passage ${unit.id}: ` +
      "a number, URL, or email address may have changed. " +
      "No translation was applied; review the source and retry."
    );
  }
}

  }
  const restoreUnit=(id:string,value:string)=>{
    const kept=keptInline.get(id);
    if(!kept)return value;
    const restored=restoreInline(value,kept);
    if(restored.missing.length){
      throw new Error('The translation model dropped a link or e-mail address, so no translation was applied. Remove the link from the text and translate it separately.');
    }
    return restored.text;
  };
  const translatedSegments=sourceSegments.map(segment=>({...segment,translation:allUnits.filter(unit=>unit.sourceId===segment.id).map(unit=>restoreUnit(unit.id,translated.get(unit.id)??'')).join('')}));
  return{translation:translatedSegments.map(segment=>segment.translation+segment.separator).join(''),translatedSegments};
}
export type WritingOperation='clarity'|'proofread'|'formal'|'simplify'|'summary'|'rewrite';

const writingGuides:Record<WritingOperation,string>={
  clarity:'Rewrite the text so it is easier to understand while preserving the original meaning, tone and level of detail.',
  proofread:'Correct grammar, spelling and punctuation only. Do not reword sentences that are already correct.',
  formal:'Rewrite the text in a formal, official register without adding claims or changing the meaning.',
  simplify:'Simplify the wording and sentence structure without losing key details.',
  summary:'Summarize only the information present in the text, keeping every fact, figure and name.',
  rewrite:'Rewrite the text while preserving its meaning, structure and factual details.',
};

const writingSystemInstruction='You are a careful bilingual English-Hindi editor for official, academic and business writing. Preserve every number, date, name, e-mail address, link and identifier exactly as written. Never invent facts, promises, names or figures.';

function stripWrapping(raw:string){
  let text=raw.trim();
  text=text.replace(/^```[a-zA-Z]*\s*/,'').replace(/\s*```$/,'').trim();
  if(text.length>1&&text.startsWith('"')&&text.endsWith('"')&&!text.slice(1,-1).includes('"'))text=text.slice(1,-1).trim();
  return text;
}

function countWords(text:string){const words=text.trim().match(/[^\s]+/g);return words?words.length:0;}

function preservedTokens(text:string){
  const linkPattern=/https?:\/\/[^\s]+|[\w.+-]+@[\w-]+\.[\w.-]+/g;
  const links=(text.match(linkPattern)??[]).map(value=>value.replace(/[.,;:!?)\]]+$/,''));
  const numbers=new Map<number,string>();
  for(const token of text.match(/\d[\d,]*(?:\.\d+)?/g)??[]){
    const numeric=Number(token.replace(/,/g,''));
    if(Number.isFinite(numeric)&&!numbers.has(numeric))numbers.set(numeric,token);
  }
  return {numbers,links};
}

export function preservationWarnings(source:string,target:string){
  const before=preservedTokens(source);const after=preservedTokens(target);
  const warnings:string[]=[];
  const missingLinks=[...new Set(before.links)].filter(value=>!after.links.includes(value));
  const missingNumbers=[...before.numbers.entries()].filter(([value])=>!after.numbers.has(value)).map(([,label])=>label);
  if(missingLinks.length)warnings.push(`Links or e-mail addresses were changed or dropped: ${missingLinks.slice(0,3).join(', ')}. Check them before using this text.`);
  if(missingNumbers.length)warnings.push(`These numbers no longer match the original exactly: ${missingNumbers.slice(0,6).join(', ')}. Check figures before using this text.`);
  return warnings;
}

export async function writingSuggestion(input:{text:string;operation:WritingOperation;language?:'English'|'Hindi'}){
  const language=input.language??(/[\u0900-\u097F]/.test(input.text)?'Hindi':'English');
  const prompt=`${writingGuides[input.operation]}\n\nWrite the result in ${language}. Keep every number, date, name, e-mail address, link and identifier exactly as written. Return only the revised text, with no quotes, headings, notes or explanations.\n\nText:\n${input.text}`;
  const suggestion=stripWrapping(await generate(prompt,{systemInstruction:writingSystemInstruction}));
  if(!suggestion)throw new Error('The writing assistant returned an empty suggestion. Your text is unchanged; please retry.');
  return {
    suggestion,
    language,
    warnings:preservationWarnings(input.text,suggestion),
    stats:{sourceWords:countWords(input.text),suggestionWords:countWords(suggestion),sourceChars:input.text.trim().length,suggestionChars:suggestion.length},
  };
}

export type EmailTone='professional'|'friendly'|'concise'|'apologetic'|'persuasive';
export type EmailLength='shorter'|'same'|'longer';
export const EMAIL_TONES:EmailTone[]=['professional','friendly','concise','apologetic','persuasive'];
export const EMAIL_LENGTHS:EmailLength[]=['shorter','same','longer'];

const toneGuides:Record<EmailTone,string>={
  professional:'Sound clear, courteous and professional',
  friendly:'Sound warm and friendly while staying respectful',
  concise:'Be direct and brief, removing filler without losing information',
  apologetic:'Acknowledge the problem sincerely and take responsibility without over-apologising',
  persuasive:'Make the request compelling while staying factual and polite',
};
const lengthGuides:Record<EmailLength,string>={
  shorter:'Keep the result noticeably shorter than the draft.',
  same:'Keep roughly the same length as the draft.',
  longer:'Expand slightly using detail that is already implied in the draft.',
};

const polishedEmailSchema=z.object({subject:z.string(),body:z.string().min(1)});

export async function polishEmail(input:{subject:string;body:string;tone?:EmailTone;length?:EmailLength}){
  if(!input.body.trim())throw new Error('Write the message before polishing it.');
  const tone=input.tone&&EMAIL_TONES.includes(input.tone)?input.tone:'professional';
  const length=input.length&&EMAIL_LENGTHS.includes(input.length)?input.length:'same';
  const prompt=`Polish this email. ${toneGuides[tone]}. ${lengthGuides[length]} Correct spelling, grammar and punctuation. Keep the same language as the draft. Preserve the sender's intent, facts, names, dates, numbers, links and identifiers exactly; do not invent details or add unsupported claims. Return only a valid JSON object with string fields "subject" and "body".\n\nDraft:\n${JSON.stringify({subject:input.subject,body:input.body})}`;
  const raw=await generate(prompt,{
    systemInstruction:writingSystemInstruction,
    responseSchema:{type:'OBJECT',properties:{subject:{type:'STRING'},body:{type:'STRING'}},required:['subject','body']},
  });
  const clean=raw.replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'').trim();
  let polished:{subject:string;body:string};
  try{polished=polishedEmailSchema.parse(JSON.parse(clean));}catch{throw new Error('The email assistant returned an unexpected format. Your draft is unchanged; please try again.');}
  if(!polished.body.trim())throw new Error('The email assistant returned an empty message. Your draft is unchanged; please try again.');
  return {
    polished:{subject:polished.subject.trim(),body:polished.body.trim()},
    tone,
    length,
    warnings:preservationWarnings(`${input.subject}\n${input.body}`,`${polished.subject}\n${polished.body}`),
    stats:{sourceWords:countWords(`${input.subject} ${input.body}`),resultWords:countWords(`${polished.subject} ${polished.body}`)},
  };
}
