import React, { useState, useRef, useEffect, DragEvent, ClipboardEvent, ChangeEvent } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { GoogleGenAI } from '@google/genai';
import JSZip from 'jszip';
import LiquidEther from './components/LiquidEther';
import BorderGlow from './components/BorderGlow';
import ClickSpark from './components/ClickSpark';
import DotField from './components/DotField';

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const DESIGN_SYSTEM_PROMPT = `你是 Design System Compiler，不是设计师。

输入是一份从提供的界面（截图或HTML源码）中提取的原始设计数据。
它是“原始数据”，不是最终系统。

你的任务是把它重建为一个“可工程使用的设计系统”。

严格执行以下步骤：

1. Token 语义重建
- 不允许直接使用 primary / secondary 这种弱语义
- 必须根据使用场景重命名：
  - action / accent / surface / text / border
- 所有 token 分两层：
  - primitive（原始色值）
  - semantic（语义映射）

2. 状态补全（必须）
为所有可交互元素生成：
- hover（亮度 +8%）
- active（亮度 -8%）
- disabled（opacity 40%）

3. Spacing 归纳
- 检测是否符合 8pt 或 4pt 体系
- 输出完整 spacing scale（至少 1~6）

4. Typography 系统化
- 转换为 token（font-size / weight / line-height）
- 构建 scale，而不是列举

5. Component 重写
- 不允许写死 hex
- 必须全部引用 semantic token
- 每个组件必须包含：
  - base
  - states（hover/active/disabled）

6. 输出结构必须是：

/tokens.css
/components.css
/guidelines.md

禁止输出解释，只输出结果`;

export default function App() {
  const [mode, setMode] = useState<'screenshot' | 'url'>('screenshot');
  const [images, setImages] = useState<{file: File, preview: string}[]>([]);
  const [url, setUrl] = useState('');
  const [result, setResult] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);
  const [hasCopied, setHasCopied] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const resultAreaRef = useRef<HTMLTextAreaElement>(null);

  // File handling
  const handleFiles = async (files: File[] | FileList) => {
    let validFiles = Array.from(files).filter(file => file.type.startsWith('image/'));
    if (validFiles.length === 0) return;

    // Limit to max 4 images total
    const remainingSlots = 4 - images.length;
    if (remainingSlots <= 0) return;
    
    // Trim incoming files if they exceed our remaining slots
    if (validFiles.length > remainingSlots) {
      validFiles = validFiles.slice(0, remainingSlots);
    }

    const newImages = await Promise.all(validFiles.map(file => {
      return new Promise<{file: File, preview: string}>((resolve) => {
        const reader = new FileReader();
        reader.onload = (e) => {
          resolve({ file, preview: e.target?.result as string });
        };
        reader.readAsDataURL(file);
      });
    }));

    setImages(prev => [...prev, ...newImages]);
  };

  const removeImage = (indexToRemove: number, e: React.MouseEvent) => {
    e.stopPropagation();
    setImages(prev => prev.filter((_, idx) => idx !== indexToRemove));
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const onDragOver = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragOver(true);
  };

  const onDragLeave = () => {
    setIsDragOver(false);
  };

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragOver(false);
    if (e.dataTransfer.files?.length > 0) {
      handleFiles(e.dataTransfer.files);
    }
  };

  const onPaste = (e: globalThis.ClipboardEvent) => {
    if (mode !== 'screenshot') return;
    const items = e.clipboardData?.items;
    if (!items) return;
    
    const imageFiles: File[] = [];
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (file) imageFiles.push(file);
      }
    }
    if (imageFiles.length > 0) handleFiles(imageFiles);
  };

  useEffect(() => {
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [mode]);

  // Generation
  const convertToBase64 = (file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.readAsDataURL(file);
      reader.onload = () => {
        const base64String = reader.result as string;
        // Strip the data:image/[type];base64, prefix
        const base64Data = base64String.split(',')[1];
        resolve(base64Data);
      };
      reader.onerror = error => reject(error);
    });
  };

  const handleGenerateScreenshot = async () => {
    if (images.length === 0) {
      fileInputRef.current?.click();
      return;
    }
    
    setIsLoading(true);
    setResult('');
    
    try {
      const parts: any[] = await Promise.all(images.map(async (img) => {
        const base64Data = await convertToBase64(img.file);
        return {
          inlineData: {
            mimeType: img.file.type,
            data: base64Data,
          }
        };
      }));

      parts.push({ text: DESIGN_SYSTEM_PROMPT });

      const responseStream = await ai.models.generateContentStream({
        model: 'gemini-2.5-flash',
        contents: {
          parts: parts,
        },
      });

      let accumulatedText = '';
      let lastUpdateDate = Date.now();
      for await (const chunk of responseStream) {
        accumulatedText += chunk.text;
        if (Date.now() - lastUpdateDate > 100) {
          setResult(accumulatedText);
          lastUpdateDate = Date.now();
        }
      }
      setResult(accumulatedText); // final flush
    } catch (error: any) {
      console.error(error);
      setResult(`Error generating Markdown: ${error.message}`);
    } finally {
      setIsLoading(false);
    }
  };

  const handleGenerateUrl = async () => {
    if (!url.trim()) return;
    
    setIsLoading(true);
    setResult('');
    
    try {
      // 1. Fetch URL content using our backend proxy
      const fetchRes = await fetch('/api/fetch-url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: url.trim() }),
      });
      
      if (!fetchRes.ok) {
        const errorData = await fetchRes.json();
        throw new Error(errorData.error || 'Failed to fetch the URL content.');
      }
      
      const { html } = await fetchRes.json();

      // 2. Pass fetched HTML text to Gemini
      const responseStream = await ai.models.generateContentStream({
        model: 'gemini-2.5-flash',
        contents: `${DESIGN_SYSTEM_PROMPT}\n\nWebsite URL: ${url}\n\nHTML Source:\n${html.slice(0, 30000)}`
      });

      let accumulatedText = '';
      let lastUpdateDate = Date.now();
      for await (const chunk of responseStream) {
        accumulatedText += chunk.text;
        if (Date.now() - lastUpdateDate > 100) {
          setResult(accumulatedText);
          lastUpdateDate = Date.now();
        }
      }
      setResult(accumulatedText); // final flush
    } catch (error: any) {
      console.error(error);
      setResult(`Error generating Markdown: ${error.message}`);
    } finally {
      setIsLoading(false);
    }
  };

  const handleCopy = () => {
    if (!result) return;
    navigator.clipboard.writeText(result).then(() => {
      setHasCopied(true);
      setTimeout(() => setHasCopied(false), 2000);
    });
  };

  const handleDownloadZip = async () => {
    if (!result) return;

    try {
      const extractContent = (filename: string) => {
        const escapedName = filename.replace(/\./g, '\\.');
        const regex = new RegExp(`(?:\\/)?${escapedName}[\\s\\S]*?\`\`\`(?:[a-z]*\\n)?([\\s\\S]*?)\`\`\``, 'i');
        const match = result.match(regex);
        return match ? match[1].trim() : '';
      };

      let tokensCss = extractContent('tokens.css');
      let componentsCss = extractContent('components.css');
      let guidelinesMd = extractContent('guidelines.md');

      // Fallback: If no codeblocks found, fallback to giving them all contents in markdown
      if (!tokensCss && !componentsCss && !guidelinesMd) {
        guidelinesMd = result;
      }

      const zip = new JSZip();
      if (tokensCss) zip.file('tokens.css', tokensCss);
      if (componentsCss) zip.file('components.css', componentsCss);
      if (guidelinesMd) zip.file('guidelines.md', guidelinesMd);
      
      // Auto-generate index.js to import css for a seamless experience
      if (tokensCss || componentsCss) {
        zip.file('index.js', `import './tokens.css';\nimport './components.css';\n\n// Design System Initialized`);
      }

      const base64 = await zip.generateAsync({ type: 'base64' });
      const a = document.createElement('a');
      a.href = `data:application/zip;base64,${base64}`;
      a.download = 'design-system.zip';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    } catch (e) {
      console.error("Failed to generate zip", e);
      alert("生成压缩包时出错！");
    }
  };

  return (
    <ClickSpark sparkColor='#fff' sparkSize={10} sparkRadius={15} sparkCount={8} duration={400}>
      <div className="min-h-screen bg-[#030508] text-[#FFFFFF] font-sans relative overflow-x-hidden flex flex-col p-6 sm:p-12">
      <div className="fixed inset-0 z-0 pointer-events-none opacity-50">
        <LiquidEther
          colors={['#6366F1', '#8F91F5', '#22D3EE']}
          mouseForce={20}
          cursorSize={100}
          isViscous={false}
          viscous={10}
          iterationsViscous={8}
          iterationsPoisson={8}
          resolution={0.25}
          isBounce={false}
          autoDemo={true}
          autoSpeed={0.3}
          autoIntensity={1.5}
          takeoverDuration={0.25}
          autoResumeDelay={3000}
          autoRampDuration={0.6}
        />
      </div>
      <div className="fixed inset-0 z-0 pointer-events-none opacity-40">
        <DotField
          dotRadius={1.5}
          dotSpacing={20}
          bulgeStrength={0}
          cursorForce={0}
          waveAmplitude={0}
          gradientFrom="#8F91F5"
          gradientTo="#22D3EE"
          glowColor="transparent"
        />
      </div>
      {/* Ambient Background Glows */}
      <div className="absolute top-[-100px] left-1/2 -translate-x-1/2 w-[600px] h-[400px] bg-[#6366F1]/10 blur-[120px] rounded-full pointer-events-none"></div>
      <div className="absolute bottom-[-100px] right-0 w-[400px] h-[300px] bg-[#22D3EE]/5 blur-[100px] rounded-full pointer-events-none"></div>

      <div className="flex flex-col items-center w-[900px] max-w-none mx-auto relative z-10 flex-1">
        <header className="w-full flex justify-between items-center mb-16 relative z-10">
          <a href="#" className="flex items-center gap-2 text-xl font-bold tracking-tight text-white no-underline hover:opacity-80 transition-opacity">
            <svg className="w-6 h-6 text-[#6366F1]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"></path>
              <polyline points="14 2 14 8 20 8"></polyline>
            </svg>
            DESIGN<span className="text-[#6366F1]">.md</span>
          </a>
        </header>

        <section className="text-center mb-10 relative z-10">
          <h1 className="text-5xl font-bold tracking-tight mb-4">将任意设计转化为 DESIGN.md</h1>
          <p className="text-gray-400 text-lg">支持上传 UI 截图，或输入任意网站生成MD 文档</p>
        </section>

        <BorderGlow
          edgeSensitivity={30}
          glowColor="250 80 70"
          backgroundColor="#0B0E13"
          borderRadius={16}
          glowRadius={20}
          glowIntensity={1.0}
          coneSpread={25}
          animated={true}
          colors={['#6366F1', '#8F91F5', '#22D3EE']}
          className="w-full shadow-2xl"
        >
          <div className="w-full bg-[#16151D] p-8 rounded-2xl relative z-10">
            <div className="flex gap-6 mb-8">
            <button 
              className={`flex-1 py-3 text-sm flex items-center justify-center gap-2 transition-all ${mode === 'screenshot' ? 'font-semibold rounded-xl bg-[#5F559C]/30 text-white border-2 border-[#5F559C] shadow-[0_0_15px_rgba(95,85,156,0.3)]' : 'font-medium rounded-xl text-gray-400 bg-white/5 hover:bg-white/10 hover:text-white border-2 border-transparent'}`}
              onClick={() => setMode('screenshot')}
            >
              <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
                <circle cx="8.5" cy="8.5" r="1.5"></circle>
                <polyline points="21 15 16 10 5 21"></polyline>
              </svg>
              扫描截图
            </button>
            <button 
              className={`flex-1 py-3 text-sm flex items-center justify-center gap-2 transition-all ${mode === 'url' ? 'font-semibold rounded-xl bg-[#5F559C]/30 text-white border-2 border-[#5F559C] shadow-[0_0_15px_rgba(95,85,156,0.3)]' : 'font-medium rounded-xl text-gray-400 bg-white/5 hover:bg-white/10 hover:text-white border-2 border-transparent'}`}
              onClick={() => setMode('url')}
            >
              <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10"></circle>
                <line x1="2" y1="12" x2="22" y2="12"></line>
                <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"></path>
              </svg>
              扫描链接
            </button>
          </div>

          <div>
            {mode === 'screenshot' && (
              <div className="animate-in fade-in duration-300">
                <div 
                  className={`min-h-[22rem] border-2 border-dashed rounded-xl flex flex-col items-center justify-center gap-3 relative transition-all overflow-hidden ${isDragOver ? 'border-[#5F559C] bg-[#5F559C]/10' : 'border-[#5F559C]/30 bg-[#5F559C]/5 hover:border-[#5F559C] hover:bg-[#5F559C]/10'} ${images.length > 0 ? 'border-solid border-white/10 bg-transparent p-4' : 'cursor-pointer'}`}
                  onClick={(e) => { if (images.length === 0) fileInputRef.current?.click(); }}
                  onDragOver={onDragOver}
                  onDragLeave={onDragLeave}
                  onDrop={onDrop}
                >
                  {images.length === 0 && (
                    <div className="flex flex-col items-center justify-center group pointer-events-none">
                      <div className="text-gray-400 group-hover:text-[#5F559C] group-hover:scale-105 transition-all">
                        <svg className="w-10 h-10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                          <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
                          <circle cx="8.5" cy="8.5" r="1.5"></circle>
                          <polyline points="21 15 16 10 5 21"></polyline>
                        </svg>
                      </div>
                      <div className="text-center mt-3">
                        <p className="text-sm font-medium text-white mb-1">Ctrl+V 粘贴截图</p>
                        <span className="text-xs text-gray-500">最多 4 张</span>
                      </div>
                    </div>
                  )}
                  {images.length > 0 && (
                    <div className="w-full h-full flex flex-col">
                      <div className="grid grid-cols-2 md:grid-cols-3 gap-4 mb-4">
                        {images.map((img, idx) => (
                          <div key={idx} className="relative aspect-video rounded-lg overflow-hidden bg-[#1B232F] group border border-white/5">
                            <img src={img.preview} alt={`Preview ${idx}`} className="w-full h-full object-cover group-hover:opacity-60 transition-opacity" />
                            <button 
                              className="absolute top-2 right-2 p-1.5 bg-black/60 rounded-full text-white hover:bg-red-500 transition-colors opacity-0 group-hover:opacity-100" 
                              type="button"
                              onClick={(e) => removeImage(idx, e)}
                            >
                              <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                                <line x1="18" y1="6" x2="6" y2="18"></line>
                                <line x1="6" y1="6" x2="18" y2="18"></line>
                              </svg>
                            </button>
                          </div>
                        ))}
                      </div>
                      {images.length < 4 ? (
                        <button 
                          className="mt-auto self-center text-sm text-[#8F91F5] hover:text-white flex items-center gap-2 px-4 py-2 rounded-lg hover:bg-white/5 transition-colors"
                          onClick={(e) => { e.stopPropagation(); fileInputRef.current?.click(); }}
                        >
                         <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
                         添加截图（{images.length}/4）
                        </button>
                      ) : (
                        <div className="mt-auto self-center text-sm text-gray-500 py-2">
                          已达到最大并行分析数量（4/4）
                        </div>
                      )}
                    </div>
                  )}
                </div>
                <input 
                  type="file" 
                  multiple
                  className="hidden" 
                  ref={fileInputRef} 
                  accept="image/*"
                  onChange={(e) => {
                    if (e.target.files?.length) handleFiles(e.target.files);
                  }}
                />
                <button 
                  className="w-full mt-4 py-3 bg-[#5F559C] hover:bg-[#7269B5] disabled:opacity-30 disabled:hover:bg-[#5F559C] disabled:cursor-not-allowed text-white font-bold rounded-xl flex items-center justify-center gap-2 shadow-lg shadow-[#5F559C]/20 transition-all active:scale-[0.99]"
                  onClick={handleGenerateScreenshot}
                  disabled={isLoading || images.length === 0}
                >
                  {isLoading ? (
                    <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M21 12a9 9 0 1 1-6.219-8.56"></path>
                    </svg>
                  ) : (
                    <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M12 3l1.9 5.8 6.1 1.2-4.4 4.3 1 6.1-5.6-2.9-5.6 2.9 1-6.1-4.4-4.3 6.1-1.2L12 3z"></path>
                    </svg>
                  )}
                  {isLoading ? '解析 Design Token 中...' : '生成 Design System'}
                </button>
              </div>
            )}

            {mode === 'url' && (
              <div className="flex flex-col gap-4 animate-in fade-in duration-300">
                <div className="relative">
                  <input 
                    type="url" 
                    className="w-full h-12 px-4 text-sm text-white bg-[#1B232F] border border-white/10 rounded-xl focus:border-[#5F559C] focus:ring-1 focus:ring-[#5F559C] outline-none transition-all placeholder:text-gray-500" 
                    placeholder="https://example.com"
                    value={url}
                    onChange={e => setUrl(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === 'Enter') handleGenerateUrl();
                    }}
                  />
                </div>
                <button 
                  className="w-full py-3 bg-[#5F559C] hover:bg-[#7269B5] disabled:opacity-30 disabled:hover:bg-[#5F559C] disabled:cursor-not-allowed text-white font-bold rounded-xl flex items-center justify-center gap-2 shadow-lg shadow-[#5F559C]/20 transition-all active:scale-[0.99]"
                  onClick={handleGenerateUrl}
                  disabled={isLoading || !url.trim()}
                >
                  {isLoading ? (
                    <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M21 12a9 9 0 1 1-6.219-8.56"></path>
                    </svg>
                  ) : (
                    <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M12 3l1.9 5.8 6.1 1.2-4.4 4.3 1 6.1-5.6-2.9-5.6 2.9 1-6.1-4.4-4.3 6.1-1.2L12 3z"></path>
                    </svg>
                  )}
                  {isLoading ? '解析 Design Token 中...' : '生成 Design System'}
                </button>
              </div>
            )}
          </div>
        </div>
        </BorderGlow>

        <section className={`w-full mt-8 transition-opacity duration-300 ${result || isLoading ? 'opacity-100' : 'opacity-0 pointer-events-none hidden'}`}>
          <div className="flex justify-between items-center mb-3">
            <span className="text-xs font-semibold text-gray-500 uppercase tracking-widest">Compiler Output</span>
            <div className="flex gap-4 items-center">
              <button className="text-xs font-medium text-[#22D3EE] hover:text-[#67e8f9] flex items-center gap-1.5 transition-colors bg-transparent border-none cursor-pointer" onClick={handleDownloadZip}>
                <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                  <polyline points="7 10 12 15 17 10"></polyline>
                  <line x1="12" y1="15" x2="12" y2="3"></line>
                </svg>
                下载系统包 (.zip)
              </button>
              <button className="text-xs font-medium text-[#5F559C] hover:text-[#7269B5] flex items-center gap-1 transition-colors bg-transparent border-none cursor-pointer border-l border-white/10 pl-4" onClick={handleCopy}>
                {hasCopied ? (
                  <>
                    <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="20 6 9 17 4 12"></polyline>
                    </svg>
                    已复制
                  </>
                ) : (
                  <>
                    <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                    </svg>
                    复制源码
                  </>
                )}
              </button>
            </div>
          </div>
          <div className="w-full bg-[#0B0E13] border border-white/10 rounded-2xl flex flex-col overflow-hidden shadow-xl" ref={resultAreaRef as any}>
            <div className="flex gap-1.5 p-4 bg-black/40 border-b border-white/5">
              <div className="w-2 h-2 rounded-full bg-white/10"></div>
              <div className="w-2 h-2 rounded-full bg-white/10"></div>
              <div className="w-2 h-2 rounded-full bg-white/10"></div>
            </div>
            
            <div className="markdown-body p-8 text-[15px] text-gray-300 w-full overflow-x-auto min-h-[400px]">
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={{
                  code({ node, inline, className, children, ...props }: any) {
                    const match = /language-(\w+)/.exec(className || '');
                    return !inline && match ? (
                      <SyntaxHighlighter
                        style={vscDarkPlus as any}
                        language={match[1]}
                        PreTag="div"
                        className="rounded-xl my-4 text-[14px] border border-white/5"
                        {...props}
                      >
                        {String(children).replace(/\n$/, '')}
                      </SyntaxHighlighter>
                    ) : (
                      <code className={`${className} bg-white/10 px-1.5 py-0.5 rounded text-[#8F91F5] font-mono`} {...props}>
                        {children}
                      </code>
                    );
                  },
                  h1: ({node, ...props}) => <h1 className="text-2xl font-bold mb-6 text-white pb-2 border-b border-white/10 mt-8 first:mt-0" {...props} />,
                  h2: ({node, ...props}) => <h2 className="text-xl font-bold mb-4 mt-8 text-white" {...props} />,
                  h3: ({node, ...props}) => <h3 className="text-lg font-bold mb-3 mt-6 text-[#8F91F5]" {...props} />,
                  p: ({node, ...props}) => <p className="mb-4 leading-relaxed" {...props} />,
                  ul: ({node, ...props}) => <ul className="list-disc pl-6 mb-4 space-y-2" {...props} />,
                  ol: ({node, ...props}) => <ol className="list-decimal pl-6 mb-4 space-y-2" {...props} />,
                  li: ({node, ...props}) => <li className="pl-1" {...props} />,
                  table: ({node, ...props}) => <div className="w-full overflow-x-auto mb-6 rounded-lg border border-white/10"><table className="w-full text-left border-collapse" {...props} /></div>,
                  th: ({node, ...props}) => <th className="p-3 bg-white/5 border-b border-white/10 font-medium text-white" {...props} />,
                  td: ({node, ...props}) => <td className="p-3 border-b border-white/5 text-gray-400" {...props} />,
                }}
              >
                {result || '# 等待系统编译输出...'}
              </ReactMarkdown>
            </div>
          </div>
        </section>
        
        {/* Bottom Status Bar */}
        <footer className="w-full mt-12 flex justify-between items-center text-[10px] text-gray-600 uppercase tracking-[0.2em] relative z-10 pb-4">
          <span>AI 引擎: Gemini Pro</span>
          <span>已连接 / 已优化</span>
        </footer>
      </div>
    </div>
    </ClickSpark>
  );
}

