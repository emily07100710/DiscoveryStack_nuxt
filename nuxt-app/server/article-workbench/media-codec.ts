import sharp from 'sharp'
import {createError} from 'h3'
import {sha256} from './protocol'
const bad=():never=>{throw createError({statusCode:422,statusMessage:'圖片格式或容量不符，請使用 JPG、PNG 或 WebP。'})}
/** Bounded decode/re-encode removes EXIF, animation and arbitrary embedded metadata. */
export async function normalizeArticleImage(bytesBase64:string,mimeType:string) {
  if(!['image/jpeg','image/png','image/webp'].includes(mimeType)||typeof bytesBase64!=='string'||bytesBase64.length>1_500_000||!/^([A-Za-z0-9+/]{4})*([A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(bytesBase64))return bad()
  const bytes=Buffer.from(bytesBase64,'base64');if(!bytes.length||bytes.length>1_048_576||bytes.toString('base64')!==bytesBase64)return bad()
  try {
    const source=sharp(bytes,{limitInputPixels:16_000_000,animated:false,failOn:'error'}),metadata=await source.metadata()
    const formats:Record<string,string>={'image/jpeg':'jpeg','image/png':'png','image/webp':'webp'}
    if(metadata.format!==formats[mimeType]||(metadata.pages||1)!==1||!metadata.width||!metadata.height||metadata.width*metadata.height>16_000_000)return bad()
    const output=await source.rotate().resize({width:1920,height:1920,fit:'inside',withoutEnlargement:true}).webp({quality:80}).toBuffer({resolveWithObject:true})
    if(!output.data.length||output.data.length>512*1024||output.info.width>1920||output.info.height>1920)return bad()
    return {bytes:output.data,bytesBase64:output.data.toString('base64'),mimeType:'image/webp' as const,sha256:sha256(output.data),size:output.data.length,width:output.info.width,height:output.info.height}
  }catch{return bad()}
}
