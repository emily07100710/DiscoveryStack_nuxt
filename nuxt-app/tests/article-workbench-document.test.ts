import {describe,expect,it} from 'vitest'
import {articleCanonicalJson,articleDocumentHash,articleMediaManifestHash,articleReferencedMedia,validateArticleDocument,validateArticleMedia} from '../server/article-workbench/document'
import {canonicalArticleJson,articleManifestHash,sha256} from '../server/article-workbench/protocol'
import {ARTICLE_DOCUMENT,ARTICLE_MEDIA} from './article-workbench-fixture'

describe('bounded canonical manual article documents',()=>{
  it('normalizes native style conventions and shares the signed receiver hash',()=>{
    const document=validateArticleDocument({...ARTICLE_DOCUMENT,title:'  合成文章  ',blocks:[{id:'p1',type:'paragraph',runs:[{text:'保持內文空白\r\n',bold:false,italic:true,color:'#ABCDEF'}]}]})
    expect(document.title).toBe('合成文章');expect(document.blocks[0]).toEqual({id:'p1',type:'paragraph',runs:[{text:'保持內文空白\r\n',italic:true,color:'#abcdef'}]})
    expect(articleCanonicalJson({z:1,a:{z:2,a:3}})).toBe(canonicalArticleJson({z:1,a:{z:2,a:3}}))
    expect(articleDocumentHash(document,[])).toBe(sha256(canonicalArticleJson({document,mediaManifest:[]})))
  })
  it('hashes only referenced immutable server media, independent of listing order',()=>{
    const document=validateArticleDocument({...ARTICLE_DOCUMENT,coverMediaId:ARTICLE_MEDIA.id})
    const extra={...ARTICLE_MEDIA,id:'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',sha256:'f'.repeat(64)}
    expect(articleDocumentHash(document,[ARTICLE_MEDIA,extra])).toBe(articleDocumentHash(document,[extra,ARTICLE_MEDIA]))
    expect(articleMediaManifestHash(document,[extra,ARTICLE_MEDIA])).toBe(articleManifestHash(articleReferencedMedia(document,[ARTICLE_MEDIA])))
    expect(articleDocumentHash(document,[ARTICLE_MEDIA])).not.toBe(articleDocumentHash(document,[{...ARTICLE_MEDIA,sha256:'a'.repeat(64)}]))
  })
  it('rejects a media reference that has no server-owned manifest',()=>{expect(()=>articleDocumentHash({...ARTICLE_DOCUMENT,coverMediaId:ARTICLE_MEDIA.id},[])).toThrow()})
  it.each([
    {...ARTICLE_DOCUMENT,unknown:true},
    {...ARTICLE_DOCUMENT,title:'<script>alert(1)</script>'},
    {...ARTICLE_DOCUMENT,slug:'../bad'},
    {...ARTICLE_DOCUMENT,slug:'media'},
    {...ARTICLE_DOCUMENT,blocks:[...ARTICLE_DOCUMENT.blocks,...ARTICLE_DOCUMENT.blocks]},
    {...ARTICLE_DOCUMENT,blocks:[{id:'p1',type:'paragraph',runs:[{text:'a',href:'https://evil.invalid'}]}]},
    {...ARTICLE_DOCUMENT,blocks:[{id:'p1',type:'image',mediaId:ARTICLE_MEDIA.id,alt:'text',caption:'',layout:'wide',url:'https://evil.invalid'}]},
    {...ARTICLE_DOCUMENT,takeaways:['a','b','c','d']},
    {...ARTICLE_DOCUMENT,blocks:[{id:'p1',type:'paragraph',runs:[{text:'a'.repeat(24_001)}]}]},
  ])('rejects unknown/executable/out-of-bound document data',value=>{expect(()=>validateArticleDocument(value)).toThrow()})
  it('allows drafts but requires complete fields and image alt for publication',()=>{
    expect(()=>validateArticleDocument({...ARTICLE_DOCUMENT,title:''})).not.toThrow()
    expect(()=>validateArticleDocument({...ARTICLE_DOCUMENT,title:''},true)).toThrow()
    expect(()=>validateArticleDocument({...ARTICLE_DOCUMENT,blocks:[...ARTICLE_DOCUMENT.blocks,{id:'image1',type:'image',mediaId:ARTICLE_MEDIA.id,alt:'',caption:'',layout:'auto'}]},true)).toThrow()
  })
  it.each([{...ARTICLE_MEDIA,url:'http://doalignment.com/pic'},{...ARTICLE_MEDIA,size:512*1024+1},{...ARTICLE_MEDIA,width:1921},{...ARTICLE_MEDIA,mimeType:'image/svg+xml'},{...ARTICLE_MEDIA,version:2},{...ARTICLE_MEDIA,url:'https://doalignment.com/pic?secret=bad'}])('rejects nonimmutable unsafe media manifest',value=>{expect(()=>validateArticleMedia(value as typeof ARTICLE_MEDIA)).toThrow()})
})
