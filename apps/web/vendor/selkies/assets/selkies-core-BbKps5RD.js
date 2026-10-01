(function(){let e=document.createElement(`link`).relList;if(e&&e.supports&&e.supports(`modulepreload`))return;for(let e of document.querySelectorAll(`link[rel="modulepreload"]`))n(e);new MutationObserver(e=>{for(let t of e)if(t.type===`childList`)for(let e of t.addedNodes)e.tagName===`LINK`&&e.rel===`modulepreload`&&n(e)}).observe(document,{childList:!0,subtree:!0});function t(e){let t={};return e.integrity&&(t.integrity=e.integrity),e.referrerPolicy&&(t.referrerPolicy=e.referrerPolicy),t.credentials=e.crossOrigin===`use-credentials`?`include`:e.crossOrigin===`anonymous`?`omit`:`same-origin`,t}function n(e){if(e.ep)return;e.ep=!0;let n=t(e);fetch(e.href,n)}})();var e={1:`h264`,2:`vp8`,3:`vp9`,4:`av1`,5:`h265`},t={jpeg:`jpeg`,h264enc:`h264`,"h264enc-striped":`h264`,h265enc:`h265`,vp8enc:`vp8`,vp9enc:`vp9`,av1enc:`av1`},n=t=>e[t>>4]||`h264`,r=e=>(e&15)==1,i=e=>t[e]||`h264`,a=e=>e===`h264`||e===`h265`||e===`vp9`,o=e=>{let t=[],n=e.length,r=-1;for(let i=0;i+2<n;i++)if(e[i]===0&&e[i+1]===0&&e[i+2]===1){if(r>=0){let n=i;for(;n>r&&e[n-1]===0;)n--;n>r&&t.push(e.subarray(r,n))}r=i+3,i+=2}return r>=0&&r<n&&t.push(e.subarray(r,n)),t},s=(e,t,n)=>{let r=[],i=0;for(let a=t;a<e.length&&r.length<n;a++){let t=e[a];if(i>=2&&t===3){i=0;continue}i=t===0?i+1:0,r.push(t)}let a=0;return{u:e=>{let t=0;for(let n=0;n<e;n++){let e=r[a>>3],n=e===void 0?0:e>>7-(a&7)&1;t=t*2+n,a++}return t},skip:e=>{a+=e}}},c=e=>{if(!e||e.length<5)return null;let t=e=>e.toString(16).toUpperCase().padStart(2,`0`);for(let n of o(e))if(!(n[0]&128)&&(n[0]&31)==7)return n.length<4?null:`avc1.${t(n[1])}${t(n[2])}${t(n[3])}`;return null},l=e=>{if(!e||e.length<5)return null;for(let t of o(e)){if((t[0]>>1&63)!=33||t.length<16)continue;let e=s(t,2,32);e.skip(8);let n=e.u(2),r=e.u(1),i=e.u(5),a=0;for(let t=0;t<32;t++)a|=e.u(1)<<t;let o=[];for(let t=0;t<6;t++)o.push(e.u(8));let c=e.u(8);for(;o.length>1&&o[o.length-1]===0;)o.pop();let l=[``,`A`,`B`,`C`][n],u=(a>>>0).toString(16).toUpperCase(),d=o.map(e=>e.toString(16).toUpperCase()).join(`.`);return`hev1.${l}${i}.${u}.${r?`H`:`L`}${c}.${d}`}return null},u=e=>{if(!e||e.length<2)return null;let t=0;for(;t<e.length;){let n=e[t],r=n>>3&15,i=!!(n&4),a=!!(n&2),o=t+1+ +!!i,c=e.length-o;if(a){c=0;let t=0;for(;;){if(o>=e.length||t>28)return null;let n=e[o++];if(c+=(n&127)*2**t,!(n&128))break;t+=7}}if(r===1){let t=s(e,o,Math.min(c,64)),n=t.u(3);t.skip(1);let r=t.u(1),i=0,a=0;if(r)i=t.u(5);else{let e=t.u(1),n=0,r=0;if(e){if(t.skip(64),t.u(1)){let e=0;for(;t.u(1)===0&&e<32;)e++;t.skip(e)}n=t.u(1),n&&(r=t.u(5)+1,t.skip(42))}let o=t.u(1);t.skip(5),t.skip(12),i=t.u(5),a=i>7?t.u(1):0,n&&t.u(1)&&t.skip(r*2+1),o&&t.u(1)&&t.skip(4)}return`av01.${n}.${String(i).padStart(2,`0`)}${a?`H`:`M`}.08`}t=o+c}return null},d=e=>{if(!e||e.length<1)return 0;let t=e[0];return t>>5&1|(t>>4&1)<<1},f=(e,t,n)=>{let r=e*t,i=r*(n>0?n:60);for(let[e,t,n]of[[`10`,829440,36864],[`11`,2764800,73728],[`20`,4608e3,122880],[`21`,9216e3,245760],[`30`,20736e3,552960],[`31`,36864e3,983040],[`40`,83558400,2228224],[`41`,160432128,2228224],[`50`,311951360,8912896],[`51`,588251136,8912896],[`52`,1176502272,8912896],[`60`,1176502272,35651584],[`61`,2353004544,35651584],[`62`,4706009088,35651584]])if(i<=t&&r<=n)return e;return`62`},p=(e,t,n)=>{let r=e*t,i=r*(n>0?n:60);for(let[n,a,o,s,c]of[[8,2359296,6144,3456,70778880],[9,2359296,6144,3456,141557760],[12,8912896,8192,4352,267386880],[13,8912896,8192,4352,534773760],[14,8912896,8192,4352,1069547520],[15,8912896,8192,4352,1069547520],[16,35651584,16384,8704,1069547520],[17,35651584,16384,8704,2139095040],[18,35651584,16384,8704,4278190080],[19,35651584,16384,8704,4278190080]])if(r<=a&&e<=o&&t<=s&&i<=c)return n;return 19},m=(e,t,n)=>{let r=Math.ceil(e/16)*Math.ceil(t/16),i=r*Math.max(n>0?n:60,60);for(let[e,t,n]of[[41,8192,245760],[42,8704,522240],[50,22080,589824],[51,36864,983040],[52,36864,2073600],[60,139264,4177920],[61,139264,8355840],[62,139264,16711680]])if(r<=t&&i<=n)return e.toString(16).toUpperCase().padStart(2,`0`);return`3E`},h=(e,t,n,r,i)=>i?`avc1.${n?`F400`:`6400`}${m(e,t,r)}`:`avc1.42E01E`,ee=(e,t,n,r,i,a,o)=>{switch(e){case`h265`:return t&&l(t)||(a?`hev1.4.10.L153.9E.8`:`hev1.1.6.L153.B0`);case`vp8`:return`vp8`;case`vp9`:return`vp09.0${t?d(t):0}.${f(n,r,i)}.08`;case`av1`:return t&&u(t)||`av01.0.${String(p(n,r,i)).padStart(2,`0`)}M.08`;default:return t&&c(t)||h(n,r,a,i,o)}},te=(e,t=!1)=>{let n=e===`vp8`;return{primaries:`bt709`,transfer:`bt709`,matrix:n?`smpte170m`:`bt709`,fullRange:!n&&!!t}},g=`AAAAAWdCwArd7ARAAAADAEAAAA8DxIngAAAAAWjOD8gAAAABZYiEOiYoDg==`,ne=e=>{let t=null,n=null;for(let r of o(e)){let e=r[0]&31;e===7&&!t?t=r:e===8&&!n&&(n=r)}if(!t||!n)return null;let r=new Uint8Array(11+t.length+n.length);return r.set([1,t[1],t[2],t[3],255,225,t.length>>8,t.length&255],0),r.set(t,8),r.set([1,n.length>>8,n.length&255],8+t.length),r.set(n,11+t.length),r},re=e=>{let t=o(e).filter(e=>{let t=e[0]&31;return t!==7&&t!==8&&t!==9}),n=0;for(let e of t)n+=4+e.length;let r=new Uint8Array(n),i=0;for(let e of t)r[i]=e.length>>>24,r[i+1]=e.length>>>16&255,r[i+2]=e.length>>>8&255,r[i+3]=e.length&255,r.set(e,i+4),i+=4+e.length;return r},ie=(e,t)=>{if(!e||!t)return!e&&!t;if(e.length!==t.length)return!1;for(let n=0;n<e.length;n++)if(e[n]!==t[n])return!1;return!0},_={h264:`avc1.42E01E`,h265:`hev1.1.6.L93.B0`,vp8:`vp8`,vp9:`vp09.00.31.08`,av1:`av01.0.05M.08`},v={h264:`avc1.F4001E`,h265:`hev1.4.10.L93.9E.8`,vp9:`vp09.01.10.08.03`},y=class{constructor(...e){this.items=[],this.enqueue(...e)}enqueue(...e){e.forEach(e=>this.items.push(e))}dequeue(e=1){return this.items.splice(0,e)[0]}size(){return this.items.length}isEmpty(){return this.items.length===0}toArray(){return[...this.items]}remove(e){var t=this.items.indexOf(e);this.items.splice(t,1)}find(e){return this.items.indexOf(e)!=-1}clear(){this.items.length=0}},b={websockets:`WebSockets`,webrtc:`WebRTC`,h264enc:`H.264`,h265enc:`H.265`,vp8enc:`VP8`,vp9enc:`VP9`,av1enc:`AV1`,"h264enc-striped":`H.264 (Striped)`,jpeg:`JPEG (Striped)`,cbr:`CBR (Constant Bitrate)`,crf:`CRF (Constant Quality)`,auto:`Auto`,h264:`H.264`,h265:`H.265`,vp8:`VP8`,vp9:`VP9`,av1:`AV1`,mjpeg:`MJPEG`},ae=e=>b[e]??e,x=1e4;async function S(e,t,n){if(typeof VideoDecoder>`u`)return!1;for(let r of[void 0,`prefer-software`])try{let i={codec:e,codedWidth:t,codedHeight:n};r&&(i.hardwareAcceleration=r);let a=await Promise.race([VideoDecoder.isConfigSupported(i),new Promise(e=>setTimeout(e,x))]);if(a&&a.supported)return!0;if(a===void 0)return!1}catch{}return!1}var oe=null;(async()=>{let e={};for(let[t,n]of Object.entries(_))e[t]=await S(n,1280,720);return oe=e,e})();var se=(async()=>{if(typeof VideoDecoder>`u`)return`annexb`;let e=Uint8Array.from(atob(g),e=>e.charCodeAt(0)),t=await new Promise(t=>{let n=null,r=e=>{if(t(e),n)try{n.terminate()}catch{}},i=setTimeout(()=>r(`annexb`),5e3);try{n=new Worker(URL.createObjectURL(new Blob([`self.onmessage = async (e) => {
        let outputs = 0;
        try {
            const dec = new VideoDecoder({ output: (f) => { outputs++; f.close(); }, error: () => {} });
            dec.configure({ codec: 'avc1.42000A', codedWidth: 16, codedHeight: 16, optimizeForLatency: true });
            dec.decode(new EncodedVideoChunk({ type: 'key', timestamp: 0, data: e.data }));
            await dec.flush();
            dec.close();
        } catch (err) { /* refused: the count says so */ }
        self.postMessage(outputs > 0 ? 'annexb' : 'avcc');
    };`],{type:`text/javascript`}))),n.onmessage=e=>{clearTimeout(i),r(e.data)},n.onerror=()=>{clearTimeout(i),r(`annexb`)},n.postMessage(e.buffer,[e.buffer])}catch{clearTimeout(i),r(`annexb`)}});return ce=t,t})(),ce=`annexb`,le=()=>ce,ue=e=>e===`jpeg`?!0:typeof VideoDecoder>`u`?!1:oe===null||oe[i(e)]!==!1,de={h264enc:`video/h264`,h265enc:`video/h265`,vp8enc:`video/vp8`,vp9enc:`video/vp9`,av1enc:`video/av1`},fe=e=>{let t=de[e];if(!t)return!1;try{let e=RTCRtpReceiver.getCapabilities(`video`);return!e||!Array.isArray(e.codecs)||e.codecs.some(e=>typeof e.mimeType==`string`&&e.mimeType.toLowerCase()===t)}catch{return!0}},C={};function pe(e=`h264`){let t=v[e];return t?(C[e]||(C[e]=S(t,320,240).then(t=>(w[e]=t,t))),C[e]):Promise.resolve(!1)}var w={},me=e=>w[e];function he(){let e=window.location.pathname;return e.substring(0,e.lastIndexOf(`/`)+1).replace(/\/$/,``)}function ge(){return typeof window>`u`?``:(window.location.origin+window.location.pathname).replace(/[^a-zA-Z0-9._-]/g,`_`)}function _e(){if(typeof navigator>`u`)return!1;let e=navigator.platform||navigator.userAgentData&&navigator.userAgentData.platform||``;return/^mac/i.test(e)&&(navigator.maxTouchPoints||0)<=1}var ve=typeof window<`u`&&typeof window.matchMedia==`function`&&window.matchMedia(`(pointer: coarse)`).matches;function ye(e){let t=e&&e.name;return t===`NotAllowedError`||t===`SecurityError`||t===`NotSupportedError`}var be={buttons:{a:0,b:1,x:2,y:3,leftshoulder:4,rightshoulder:5,lefttrigger:6,righttrigger:7,back:8,start:9,leftstick:10,rightstick:11,dpup:12,dpdown:13,dpleft:14,dpright:15,guide:16},axes:{leftx:0,lefty:1,rightx:2,righty:3}},T=4,E=(()=>{let e=typeof navigator<`u`&&navigator.userAgent||``;return/iPhone|iPad|iPod/i.test(e)?`ios`:/Android/i.test(e)?`android`:/Windows/i.test(e)?`windows`:/Macintosh|Mac OS X/i.test(e)?`mac`:`linux`})(),D=class{constructor(e,t,n,r){this.gamepad=e,this.onButton=t,this.onAxis=n,this.onHeld=r||null,this._lastHeldBeat=0,this.state={},this._active=!0,this.interval=setInterval(()=>{this._poll()},16)}enable(){this._active||(this._active=!0,console.log(`GamepadManager polling activated.`))}disable(){this._active&&(this._active=!1,console.log(`GamepadManager polling deactivated.`))}async _loadRemapProfile(e,t){t.loadingProfile=!0;let n=`jsdb/${E}/${e}.json`;try{console.log(`Attempting to load mapping for ${e} from ${n}`);let r=await fetch(n);if(!r.ok){r.status===404?console.log(`No custom mapping file found for ${e}. Using browser default.`):console.warn(`Failed to load mapping for ${e} (HTTP Status: ${r.status})`),t.remapProfile=null;return}let i=await r.json();console.log(`Successfully loaded and applying custom mapping for: ${e}`);let a={buttons:{},axes:{}};for(let e in i){let t=i[e];if(t.type===`button`){let n=be.buttons[e];n!==void 0&&(a.buttons[t.index]=n)}else if(t.type===`axis`){let n=be.axes[e];n!==void 0&&(a.axes[t.index]=n)}}t.remapProfile=a}catch(n){console.error(`Error fetching or parsing mapping file for ${e}:`,n),t.remapProfile=null}}_poll(){if(!this._active)return;let e=navigator.getGamepads();for(let t=0;t<T;t++){let n=e[t];if(n){let e=this.state[t];if(!e&&(e=this.state[t]={axes:Array(n.axes.length).fill(0),buttons:Array(n.buttons.length).fill(0),dpadAxisState:{12:!1,13:!1,14:!1,15:!1},remapProfile:null,loadingProfile:!1},n.mapping!==`standard`)){let t=n.id.match(/Vendor: ([0-9a-f]{4}) Product: ([0-9a-f]{4})/i);if(t&&!e.loadingProfile){let n=`${t[1].toLowerCase()}-${t[2].toLowerCase()}`;this._loadRemapProfile(n,e)}}e.buttons.length!==n.buttons.length&&(e.buttons=Array(n.buttons.length).fill(0)),e.axes.length!==n.axes.length&&(e.axes=Array(n.axes.length).fill(0));for(let r=0;r<n.buttons.length;r++){if(n.buttons[r]===void 0)continue;let i=n.buttons[r].value,a=n.buttons[r].pressed,o=r;if(n.mapping!==`standard`&&navigator.userAgent.includes(`Firefox`)&&(r===2?o=3:r===3&&(o=2)),e.buttons[r]!==i){if(e.remapProfile){let t=e.remapProfile.buttons[o];if(t!==void 0)o=t;else continue}this.onButton(t,o,i,a),e.buttons[r]=i}}for(let r=0;r<n.axes.length;r++){if(n.axes[r]===void 0)continue;let i=n.axes[r];if(Math.abs(i)<.05&&(i=0),e.axes[r]!==i){if(n.mapping===`standard`||r!==4&&r!==5){let n=r;e.remapProfile&&e.remapProfile.axes[r]!==void 0&&(n=e.remapProfile.axes[r]),this.onAxis(t,n,i)}e.axes[r]=i}}if(n.mapping!==`standard`&&n.axes.length>=6){let r=.5,i={up:n.axes[5]<-.5,down:n.axes[5]>r,left:n.axes[4]<-.5,right:n.axes[4]>r};i.up!==e.dpadAxisState[12]&&(this.onButton(t,12,+!!i.up,i.up),e.dpadAxisState[12]=i.up),i.down!==e.dpadAxisState[13]&&(this.onButton(t,13,+!!i.down,i.down),e.dpadAxisState[13]=i.down),i.left!==e.dpadAxisState[14]&&(this.onButton(t,14,+!!i.left,i.left),e.dpadAxisState[14]=i.left),i.right!==e.dpadAxisState[15]&&(this.onButton(t,15,+!!i.right,i.right),e.dpadAxisState[15]=i.right)}}else this.state[t]&&delete this.state[t]}if(this.onHeld&&this._anyHeld()){let e=Date.now();e-this._lastHeldBeat>=100&&(this._lastHeldBeat=e,this.onHeld())}}_anyHeld(){for(let e in this.state){let t=this.state[e];if(t.buttons.some(e=>e!==0)||t.axes.some(e=>e!==0))return!0}return!1}destroy(){clearInterval(this.interval),this.state={},console.log(`GamepadManager destroyed.`)}};function xe(e){"@babel/helpers - typeof";return xe=typeof Symbol==`function`&&typeof Symbol.iterator==`symbol`?function(e){return typeof e}:function(e){return e&&typeof Symbol==`function`&&e.constructor===Symbol&&e!==Symbol.prototype?`symbol`:typeof e},xe(e)}function Se(e,t){if(xe(e)!=`object`||!e)return e;var n=e[Symbol.toPrimitive];if(n!==void 0){var r=n.call(e,t||`default`);if(xe(r)!=`object`)return r;throw TypeError(`@@toPrimitive must return a primitive value.`)}return(t===`string`?String:Number)(e)}function O(e){var t=Se(e,`string`);return xe(t)==`symbol`?t:t+``}function Ce(e,t,n){return(t=O(t))in e?Object.defineProperty(e,t,{value:n,enumerable:!0,configurable:!0,writable:!0}):e[t]=n,e}var we=`allow-native-input`;function Te(e){return e&-7|(e&2)<<1|(e&4)>>1}var k={ShiftLeft:`Shift`,ShiftRight:`Shift`,ControlLeft:`Control`,ControlRight:`Control`,AltLeft:`Alt`,AltRight:`Alt`,MetaLeft:`Meta`,MetaRight:`Meta`};function Ee(e){return!!e.altKey||typeof e.getModifierState==`function`&&e.getModifierState(`AltGraph`)}function De(e,t){return t?t===`Alt`?Ee(e):e.getModifierState(t):!1}function Oe(e){if(typeof e!=`string`||[...e].length!==1)return!1;let t=e.codePointAt(0);return t>=32&&t!==127}function ke(e){return e.isTrusted!==!1||e.__selkiesClipReplay===!0}var A={XK_VoidSymbol:16777215,XK_BackSpace:65288,XK_Tab:65289,XK_Linefeed:65290,XK_Clear:65291,XK_Return:65293,XK_Pause:65299,XK_Scroll_Lock:65300,XK_Sys_Req:65301,XK_Escape:65307,XK_Delete:65535,XK_Multi_key:65312,XK_Codeinput:65335,XK_SingleCandidate:65340,XK_MultipleCandidate:65341,XK_PreviousCandidate:65342,XK_Kanji:65313,XK_Muhenkan:65314,XK_Henkan_Mode:65315,XK_Henkan:65315,XK_Romaji:65316,XK_Hiragana:65317,XK_Katakana:65318,XK_Hiragana_Katakana:65319,XK_Zenkaku:65320,XK_Hankaku:65321,XK_Zenkaku_Hankaku:65322,XK_Touroku:65323,XK_Massyo:65324,XK_Kana_Lock:65325,XK_Kana_Shift:65326,XK_Eisu_Shift:65327,XK_Eisu_toggle:65328,XK_Kanji_Bangou:65335,XK_Zen_Koho:65341,XK_Mae_Koho:65342,XK_Home:65360,XK_Left:65361,XK_Up:65362,XK_Right:65363,XK_Down:65364,XK_Prior:65365,XK_Page_Up:65365,XK_Next:65366,XK_Page_Down:65366,XK_End:65367,XK_Begin:65368,XK_Select:65376,XK_Print:65377,XK_Execute:65378,XK_Insert:65379,XK_Undo:65381,XK_Redo:65382,XK_Menu:65383,XK_Find:65384,XK_Cancel:65385,XK_Help:65386,XK_Break:65387,XK_Mode_switch:65406,XK_script_switch:65406,XK_Num_Lock:65407,XK_KP_Space:65408,XK_KP_Tab:65417,XK_KP_Enter:65421,XK_KP_F1:65425,XK_KP_F2:65426,XK_KP_F3:65427,XK_KP_F4:65428,XK_KP_Home:65429,XK_KP_Left:65430,XK_KP_Up:65431,XK_KP_Right:65432,XK_KP_Down:65433,XK_KP_Prior:65434,XK_KP_Page_Up:65434,XK_KP_Next:65435,XK_KP_Page_Down:65435,XK_KP_End:65436,XK_KP_Begin:65437,XK_KP_Insert:65438,XK_KP_Delete:65439,XK_KP_Equal:65469,XK_KP_Multiply:65450,XK_KP_Add:65451,XK_KP_Separator:65452,XK_KP_Subtract:65453,XK_KP_Decimal:65454,XK_KP_Divide:65455,XK_KP_0:65456,XK_KP_1:65457,XK_KP_2:65458,XK_KP_3:65459,XK_KP_4:65460,XK_KP_5:65461,XK_KP_6:65462,XK_KP_7:65463,XK_KP_8:65464,XK_KP_9:65465,XK_F1:65470,XK_F2:65471,XK_F3:65472,XK_F4:65473,XK_F5:65474,XK_F6:65475,XK_F7:65476,XK_F8:65477,XK_F9:65478,XK_F10:65479,XK_F11:65480,XK_L1:65480,XK_F12:65481,XK_L2:65481,XK_F13:65482,XK_L3:65482,XK_F14:65483,XK_L4:65483,XK_F15:65484,XK_L5:65484,XK_F16:65485,XK_L6:65485,XK_F17:65486,XK_L7:65486,XK_F18:65487,XK_L8:65487,XK_F19:65488,XK_L9:65488,XK_F20:65489,XK_L10:65489,XK_F21:65490,XK_R1:65490,XK_F22:65491,XK_R2:65491,XK_F23:65492,XK_R3:65492,XK_F24:65493,XK_R4:65493,XK_F25:65494,XK_R5:65494,XK_F26:65495,XK_R6:65495,XK_F27:65496,XK_R7:65496,XK_F28:65497,XK_R8:65497,XK_F29:65498,XK_R9:65498,XK_F30:65499,XK_R10:65499,XK_F31:65500,XK_R11:65500,XK_F32:65501,XK_R12:65501,XK_F33:65502,XK_R13:65502,XK_F34:65503,XK_R14:65503,XK_F35:65504,XK_R15:65504,XK_Shift_L:65505,XK_Shift_R:65506,XK_Control_L:65507,XK_Control_R:65508,XK_Caps_Lock:65509,XK_Shift_Lock:65510,XK_Meta_L:65511,XK_Meta_R:65512,XK_Alt_L:65513,XK_Alt_R:65514,XK_Super_L:65515,XK_Super_R:65516,XK_Hyper_L:65517,XK_Hyper_R:65518,XK_ISO_Level3_Shift:65027,XK_ISO_Next_Group:65032,XK_ISO_Prev_Group:65034,XK_ISO_First_Group:65036,XK_ISO_Last_Group:65038,XK_space:32,XK_exclam:33,XK_quotedbl:34,XK_numbersign:35,XK_dollar:36,XK_percent:37,XK_ampersand:38,XK_apostrophe:39,XK_quoteright:39,XK_parenleft:40,XK_parenright:41,XK_asterisk:42,XK_plus:43,XK_comma:44,XK_minus:45,XK_period:46,XK_slash:47,XK_0:48,XK_1:49,XK_2:50,XK_3:51,XK_4:52,XK_5:53,XK_6:54,XK_7:55,XK_8:56,XK_9:57,XK_colon:58,XK_semicolon:59,XK_less:60,XK_equal:61,XK_greater:62,XK_question:63,XK_at:64,XK_A:65,XK_B:66,XK_C:67,XK_D:68,XK_E:69,XK_F:70,XK_G:71,XK_H:72,XK_I:73,XK_J:74,XK_K:75,XK_L:76,XK_M:77,XK_N:78,XK_O:79,XK_P:80,XK_Q:81,XK_R:82,XK_S:83,XK_T:84,XK_U:85,XK_V:86,XK_W:87,XK_X:88,XK_Y:89,XK_Z:90,XK_bracketleft:91,XK_backslash:92,XK_bracketright:93,XK_asciicircum:94,XK_underscore:95,XK_grave:96,XK_quoteleft:96,XK_a:97,XK_b:98,XK_c:99,XK_d:100,XK_e:101,XK_f:102,XK_g:103,XK_h:104,XK_i:105,XK_j:106,XK_k:107,XK_l:108,XK_m:109,XK_n:110,XK_o:111,XK_p:112,XK_q:113,XK_r:114,XK_s:115,XK_t:116,XK_u:117,XK_v:118,XK_w:119,XK_x:120,XK_y:121,XK_z:122,XK_braceleft:123,XK_bar:124,XK_braceright:125,XK_asciitilde:126,XK_nobreakspace:160,XK_exclamdown:161,XK_cent:162,XK_sterling:163,XK_currency:164,XK_yen:165,XK_brokenbar:166,XK_section:167,XK_diaeresis:168,XK_copyright:169,XK_ordfeminine:170,XK_guillemotleft:171,XK_notsign:172,XK_hyphen:173,XK_registered:174,XK_macron:175,XK_degree:176,XK_plusminus:177,XK_twosuperior:178,XK_threesuperior:179,XK_acute:180,XK_mu:181,XK_paragraph:182,XK_periodcentered:183,XK_cedilla:184,XK_onesuperior:185,XK_masculine:186,XK_guillemotright:187,XK_onequarter:188,XK_onehalf:189,XK_threequarters:190,XK_questiondown:191,XK_Agrave:192,XK_Aacute:193,XK_Acircumflex:194,XK_Atilde:195,XK_Adiaeresis:196,XK_Aring:197,XK_AE:198,XK_Ccedilla:199,XK_Egrave:200,XK_Eacute:201,XK_Ecircumflex:202,XK_Ediaeresis:203,XK_Igrave:204,XK_Iacute:205,XK_Icircumflex:206,XK_Idiaeresis:207,XK_ETH:208,XK_Eth:208,XK_Ntilde:209,XK_Ograve:210,XK_Oacute:211,XK_Ocircumflex:212,XK_Otilde:213,XK_Odiaeresis:214,XK_multiply:215,XK_Oslash:216,XK_Ooblique:216,XK_Ugrave:217,XK_Uacute:218,XK_Ucircumflex:219,XK_Udiaeresis:220,XK_Yacute:221,XK_THORN:222,XK_Thorn:222,XK_ssharp:223,XK_agrave:224,XK_aacute:225,XK_acircumflex:226,XK_atilde:227,XK_adiaeresis:228,XK_aring:229,XK_ae:230,XK_ccedilla:231,XK_egrave:232,XK_eacute:233,XK_ecircumflex:234,XK_ediaeresis:235,XK_igrave:236,XK_iacute:237,XK_icircumflex:238,XK_idiaeresis:239,XK_eth:240,XK_ntilde:241,XK_ograve:242,XK_oacute:243,XK_ocircumflex:244,XK_otilde:245,XK_odiaeresis:246,XK_division:247,XK_oslash:248,XK_ooblique:248,XK_ugrave:249,XK_uacute:250,XK_ucircumflex:251,XK_udiaeresis:252,XK_yacute:253,XK_thorn:254,XK_ydiaeresis:255,XK_Hangul:65329,XK_Hangul_Hanja:65332,XK_Hangul_Jeonja:65336,XF86XK_ModeLock:269025025,XF86XK_MonBrightnessUp:269025026,XF86XK_MonBrightnessDown:269025027,XF86XK_KbdLightOnOff:269025028,XF86XK_KbdBrightnessUp:269025029,XF86XK_KbdBrightnessDown:269025030,XF86XK_Standby:269025040,XF86XK_AudioLowerVolume:269025041,XF86XK_AudioMute:269025042,XF86XK_AudioRaiseVolume:269025043,XF86XK_AudioPlay:269025044,XF86XK_AudioStop:269025045,XF86XK_AudioPrev:269025046,XF86XK_AudioNext:269025047,XF86XK_HomePage:269025048,XF86XK_Mail:269025049,XF86XK_Start:269025050,XF86XK_Search:269025051,XF86XK_AudioRecord:269025052,XF86XK_Calculator:269025053,XF86XK_Memo:269025054,XF86XK_ToDoList:269025055,XF86XK_Calendar:269025056,XF86XK_PowerDown:269025057,XF86XK_ContrastAdjust:269025058,XF86XK_RockerUp:269025059,XF86XK_RockerDown:269025060,XF86XK_RockerEnter:269025061,XF86XK_Back:269025062,XF86XK_Forward:269025063,XF86XK_Stop:269025064,XF86XK_Refresh:269025065,XF86XK_PowerOff:269025066,XF86XK_WakeUp:269025067,XF86XK_Eject:269025068,XF86XK_ScreenSaver:269025069,XF86XK_WWW:269025070,XF86XK_Sleep:269025071,XF86XK_Favorites:269025072,XF86XK_AudioPause:269025073,XF86XK_AudioMedia:269025074,XF86XK_MyComputer:269025075,XF86XK_VendorHome:269025076,XF86XK_LightBulb:269025077,XF86XK_Shop:269025078,XF86XK_History:269025079,XF86XK_OpenURL:269025080,XF86XK_AddFavorite:269025081,XF86XK_HotLinks:269025082,XF86XK_BrightnessAdjust:269025083,XF86XK_Finance:269025084,XF86XK_Community:269025085,XF86XK_AudioRewind:269025086,XF86XK_BackForward:269025087,XF86XK_Launch0:269025088,XF86XK_Launch1:269025089,XF86XK_Launch2:269025090,XF86XK_Launch3:269025091,XF86XK_Launch4:269025092,XF86XK_Launch5:269025093,XF86XK_Launch6:269025094,XF86XK_Launch7:269025095,XF86XK_Launch8:269025096,XF86XK_Launch9:269025097,XF86XK_LaunchA:269025098,XF86XK_LaunchB:269025099,XF86XK_LaunchC:269025100,XF86XK_LaunchD:269025101,XF86XK_LaunchE:269025102,XF86XK_LaunchF:269025103,XF86XK_ApplicationLeft:269025104,XF86XK_ApplicationRight:269025105,XF86XK_Book:269025106,XF86XK_CD:269025107,XF86XK_Calculater:269025108,XF86XK_Clear:269025109,XF86XK_Close:269025110,XF86XK_Copy:269025111,XF86XK_Cut:269025112,XF86XK_Display:269025113,XF86XK_DOS:269025114,XF86XK_Documents:269025115,XF86XK_Excel:269025116,XF86XK_Explorer:269025117,XF86XK_Game:269025118,XF86XK_Go:269025119,XF86XK_iTouch:269025120,XF86XK_LogOff:269025121,XF86XK_Market:269025122,XF86XK_Meeting:269025123,XF86XK_MenuKB:269025125,XF86XK_MenuPB:269025126,XF86XK_MySites:269025127,XF86XK_New:269025128,XF86XK_News:269025129,XF86XK_OfficeHome:269025130,XF86XK_Open:269025131,XF86XK_Option:269025132,XF86XK_Paste:269025133,XF86XK_Phone:269025134,XF86XK_Q:269025136,XF86XK_Reply:269025138,XF86XK_Reload:269025139,XF86XK_RotateWindows:269025140,XF86XK_RotationPB:269025141,XF86XK_RotationKB:269025142,XF86XK_Save:269025143,XF86XK_ScrollUp:269025144,XF86XK_ScrollDown:269025145,XF86XK_ScrollClick:269025146,XF86XK_Send:269025147,XF86XK_Spell:269025148,XF86XK_SplitScreen:269025149,XF86XK_Support:269025150,XF86XK_TaskPane:269025151,XF86XK_Terminal:269025152,XF86XK_Tools:269025153,XF86XK_Travel:269025154,XF86XK_UserPB:269025156,XF86XK_User1KB:269025157,XF86XK_User2KB:269025158,XF86XK_Video:269025159,XF86XK_WheelButton:269025160,XF86XK_Word:269025161,XF86XK_Xfer:269025162,XF86XK_ZoomIn:269025163,XF86XK_ZoomOut:269025164,XF86XK_Away:269025165,XF86XK_Messenger:269025166,XF86XK_WebCam:269025167,XF86XK_MailForward:269025168,XF86XK_Pictures:269025169,XF86XK_Music:269025170,XF86XK_Battery:269025171,XF86XK_Bluetooth:269025172,XF86XK_WLAN:269025173,XF86XK_UWB:269025174,XF86XK_AudioForward:269025175,XF86XK_AudioRepeat:269025176,XF86XK_AudioRandomPlay:269025177,XF86XK_Subtitle:269025178,XF86XK_AudioCycleTrack:269025179,XF86XK_CycleAngle:269025180,XF86XK_FrameBack:269025181,XF86XK_FrameForward:269025182,XF86XK_Time:269025183,XF86XK_Select:269025184,XF86XK_View:269025185,XF86XK_TopMenu:269025186,XF86XK_Red:269025187,XF86XK_Green:269025188,XF86XK_Yellow:269025189,XF86XK_Blue:269025190,XF86XK_Suspend:269025191,XF86XK_Hibernate:269025192,XF86XK_TouchpadToggle:269025193,XF86XK_TouchpadOn:269025200,XF86XK_TouchpadOff:269025201,XF86XK_AudioMicMute:269025202,XF86XK_Switch_VT_1:269024769,XF86XK_Switch_VT_2:269024770,XF86XK_Switch_VT_3:269024771,XF86XK_Switch_VT_4:269024772,XF86XK_Switch_VT_5:269024773,XF86XK_Switch_VT_6:269024774,XF86XK_Switch_VT_7:269024775,XF86XK_Switch_VT_8:269024776,XF86XK_Switch_VT_9:269024777,XF86XK_Switch_VT_10:269024778,XF86XK_Switch_VT_11:269024779,XF86XK_Switch_VT_12:269024780,XF86XK_Ungrab:269024800,XF86XK_ClearGrab:269024801,XF86XK_Next_VMode:269024802,XF86XK_Prev_VMode:269024803,XF86XK_LogWindowTree:269024804,XF86XK_LogGrabInfo:269024805},Ae={256:960,257:992,258:451,259:483,260:417,261:433,262:454,263:486,264:710,265:742,266:709,267:741,268:456,269:488,270:463,271:495,272:464,273:496,274:938,275:954,278:972,279:1004,280:458,281:490,282:460,283:492,284:728,285:760,286:683,287:699,288:725,289:757,290:939,291:955,292:678,293:694,294:673,295:689,296:933,297:949,298:975,299:1007,302:967,303:999,304:681,305:697,308:684,309:700,310:979,311:1011,312:930,313:453,314:485,315:934,316:950,317:421,318:437,321:419,322:435,323:465,324:497,325:977,326:1009,327:466,328:498,330:957,331:959,332:978,333:1010,336:469,337:501,338:5052,339:5053,340:448,341:480,342:931,343:947,344:472,345:504,346:422,347:438,348:734,349:766,350:426,351:442,352:425,353:441,354:478,355:510,356:427,357:443,358:940,359:956,360:989,361:1021,362:990,363:1022,364:733,365:765,366:473,367:505,368:475,369:507,370:985,371:1017,376:5054,377:428,378:444,379:431,380:447,381:430,382:446,402:2294,466:16777681,711:439,728:418,729:511,731:434,733:445,901:1966,902:1953,904:1954,905:1955,906:1956,908:1959,910:1960,911:1963,912:1974,913:1985,914:1986,915:1987,916:1988,917:1989,918:1990,919:1991,920:1992,921:1993,922:1994,923:1995,924:1996,925:1997,926:1998,927:1999,928:2e3,929:2001,931:2002,932:2004,933:2005,934:2006,935:2007,936:2008,937:2009,938:1957,939:1961,940:1969,941:1970,942:1971,943:1972,944:1978,945:2017,946:2018,947:2019,948:2020,949:2021,950:2022,951:2023,952:2024,953:2025,954:2026,955:2027,956:2028,957:2029,958:2030,959:2031,960:2032,961:2033,962:2035,963:2034,964:2036,965:2037,966:2038,967:2039,968:2040,969:2041,970:1973,971:1977,972:1975,973:1976,974:1979,1025:1715,1026:1713,1027:1714,1028:1716,1029:1717,1030:1718,1031:1719,1032:1720,1033:1721,1034:1722,1035:1723,1036:1724,1038:1726,1039:1727,1040:1761,1041:1762,1042:1783,1043:1767,1044:1764,1045:1765,1046:1782,1047:1786,1048:1769,1049:1770,1050:1771,1051:1772,1052:1773,1053:1774,1054:1775,1055:1776,1056:1778,1057:1779,1058:1780,1059:1781,1060:1766,1061:1768,1062:1763,1063:1790,1064:1787,1065:1789,1066:1791,1067:1785,1068:1784,1069:1788,1070:1760,1071:1777,1072:1729,1073:1730,1074:1751,1075:1735,1076:1732,1077:1733,1078:1750,1079:1754,1080:1737,1081:1738,1082:1739,1083:1740,1084:1741,1085:1742,1086:1743,1087:1744,1088:1746,1089:1747,1090:1748,1091:1749,1092:1734,1093:1736,1094:1731,1095:1758,1096:1755,1097:1757,1098:1759,1099:1753,1100:1752,1101:1756,1102:1728,1103:1745,1105:1699,1106:1697,1107:1698,1108:1700,1109:1701,1110:1702,1111:1703,1112:1704,1113:1705,1114:1706,1115:1707,1116:1708,1118:1710,1119:1711,1168:1725,1169:1709,1488:3296,1489:3297,1490:3298,1491:3299,1492:3300,1493:3301,1494:3302,1495:3303,1496:3304,1497:3305,1498:3306,1499:3307,1500:3308,1501:3309,1502:3310,1503:3311,1504:3312,1505:3313,1506:3314,1507:3315,1508:3316,1509:3317,1510:3318,1511:3319,1512:3320,1513:3321,1514:3322,1548:1452,1563:1467,1567:1471,1569:1473,1570:1474,1571:1475,1572:1476,1573:1477,1574:1478,1575:1479,1576:1480,1577:1481,1578:1482,1579:1483,1580:1484,1581:1485,1582:1486,1583:1487,1584:1488,1585:1489,1586:1490,1587:1491,1588:1492,1589:1493,1590:1494,1591:1495,1592:1496,1593:1497,1594:1498,1600:1504,1601:1505,1602:1506,1603:1507,1604:1508,1605:1509,1606:1510,1607:1511,1608:1512,1609:1513,1610:1514,1611:1515,1612:1516,1613:1517,1614:1518,1615:1519,1616:1520,1617:1521,1618:1522,3585:3489,3586:3490,3587:3491,3588:3492,3589:3493,3590:3494,3591:3495,3592:3496,3593:3497,3594:3498,3595:3499,3596:3500,3597:3501,3598:3502,3599:3503,3600:3504,3601:3505,3602:3506,3603:3507,3604:3508,3605:3509,3606:3510,3607:3511,3608:3512,3609:3513,3610:3514,3611:3515,3612:3516,3613:3517,3614:3518,3615:3519,3616:3520,3617:3521,3618:3522,3619:3523,3620:3524,3621:3525,3622:3526,3623:3527,3624:3528,3625:3529,3626:3530,3627:3531,3628:3532,3629:3533,3630:3534,3631:3535,3632:3536,3633:3537,3634:3538,3635:3539,3636:3540,3637:3541,3638:3542,3639:3543,3640:3544,3641:3545,3642:3546,3647:3551,3648:3552,3649:3553,3650:3554,3651:3555,3652:3556,3653:3557,3654:3558,3655:3559,3656:3560,3657:3561,3658:3562,3659:3563,3660:3564,3661:3565,3664:3568,3665:3569,3666:3570,3667:3571,3668:3572,3669:3573,3670:3574,3671:3575,3672:3576,3673:3577,8194:2722,8195:2721,8196:2723,8197:2724,8199:2725,8200:2726,8201:2727,8202:2728,8210:2747,8211:2730,8212:2729,8213:1967,8215:3295,8216:2768,8217:2769,8218:2813,8220:2770,8221:2771,8222:2814,8224:2801,8225:2802,8226:2790,8229:2735,8230:2734,8240:2773,8242:2774,8243:2775,8248:2812,8254:1150,8361:3839,8364:8364,8453:2744,8470:1712,8471:2811,8478:2772,8482:2761,8531:2736,8532:2737,8533:2738,8534:2739,8535:2740,8536:2741,8537:2742,8538:2743,8539:2755,8540:2756,8541:2757,8542:2758,8592:2299,8593:2300,8594:2301,8595:2302,8658:2254,8660:2253,8706:2287,8711:2245,8728:3018,8730:2262,8733:2241,8734:2242,8743:2270,8744:2271,8745:2268,8746:2269,8747:2239,8756:2240,8764:2248,8771:2249,8773:16785992,8800:2237,8801:2255,8804:2236,8805:2238,8834:2266,8835:2267,8866:3068,8867:3036,8868:3010,8869:3022,8968:3027,8970:3012,8981:2810,8992:2212,8993:2213,9109:3020,9115:2219,9117:2220,9118:2221,9120:2222,9121:2215,9123:2216,9124:2217,9126:2218,9128:2223,9132:2224,9143:2209,9146:2543,9147:2544,9148:2546,9149:2547,9225:2530,9226:2533,9227:2537,9228:2531,9229:2532,9251:2732,9252:2536,9472:2211,9474:2214,9484:2210,9488:2539,9492:2541,9496:2538,9500:2548,9508:2549,9516:2551,9524:2550,9532:2542,9618:2529,9642:2791,9643:2785,9644:2779,9645:2786,9646:2783,9647:2767,9650:2792,9651:2787,9654:2781,9655:2765,9660:2793,9661:2788,9664:2780,9665:2764,9670:2528,9675:2766,9679:2782,9702:2784,9734:2789,9742:2809,9747:2762,9756:2794,9758:2795,9792:2808,9794:2807,9827:2796,9829:2798,9830:2797,9837:2806,9839:2805,10003:2803,10007:2804,10013:2777,10016:2800,10216:2748,10217:2750,12289:1188,12290:1185,12300:1186,12301:1187,12443:1246,12444:1247,12449:1191,12450:1201,12451:1192,12452:1202,12453:1193,12454:1203,12455:1194,12456:1204,12457:1195,12458:1205,12459:1206,12461:1207,12463:1208,12465:1209,12467:1210,12469:1211,12471:1212,12473:1213,12475:1214,12477:1215,12479:1216,12481:1217,12483:1199,12484:1218,12486:1219,12488:1220,12490:1221,12491:1222,12492:1223,12493:1224,12494:1225,12495:1226,12498:1227,12501:1228,12504:1229,12507:1230,12510:1231,12511:1232,12512:1233,12513:1234,12514:1235,12515:1196,12516:1236,12517:1197,12518:1237,12519:1198,12520:1238,12521:1239,12522:1240,12523:1241,12524:1242,12525:1243,12527:1244,12530:1190,12531:1245,12539:1189,12540:1200},j={lookup:function(e){if(e>=32&&e<=255)return e;let t=Ae[e];return t===void 0?16777216|e:t}},je={};(function(){function e(e,t){if(t===void 0)throw Error(`Undefined keysym for key "`+e+`"`);if(e in je)throw Error(`Duplicate entry for key "`+e+`"`);je[e]=[t,t,t,t]}function t(e,t,n){if(t===void 0||n===void 0)throw Error(`Undefined keysym for key "`+e+`"`);if(e in je)throw Error(`Duplicate entry for key "`+e+`"`);je[e]=[t,t,n,t]}function n(e,t,n){if(t===void 0||n===void 0)throw Error(`Undefined keysym for key "`+e+`"`);if(e in je)throw Error(`Duplicate entry for key "`+e+`"`);je[e]=[t,t,t,n]}t(`Alt`,A.XK_Alt_L,A.XK_Alt_R),e(`AltGraph`,A.XK_ISO_Level3_Shift),e(`CapsLock`,A.XK_Caps_Lock),t(`Control`,A.XK_Control_L,A.XK_Control_R),t(`Meta`,A.XK_Super_L,A.XK_Super_R),e(`NumLock`,A.XK_Num_Lock),e(`ScrollLock`,A.XK_Scroll_Lock),t(`Shift`,A.XK_Shift_L,A.XK_Shift_R),n(`Enter`,A.XK_Return,A.XK_KP_Enter),e(`Tab`,A.XK_Tab),n(` `,A.XK_space,A.XK_KP_Space),n(`ArrowDown`,A.XK_Down,A.XK_KP_Down),n(`ArrowLeft`,A.XK_Left,A.XK_KP_Left),n(`ArrowRight`,A.XK_Right,A.XK_KP_Right),n(`ArrowUp`,A.XK_Up,A.XK_KP_Up),n(`End`,A.XK_End,A.XK_KP_End),n(`Home`,A.XK_Home,A.XK_KP_Home),n(`PageDown`,A.XK_Next,A.XK_KP_Next),n(`PageUp`,A.XK_Prior,A.XK_KP_Prior),e(`Backspace`,A.XK_BackSpace),n(`Clear`,A.XK_Clear,A.XK_KP_Begin),e(`Copy`,A.XF86XK_Copy),e(`Cut`,A.XF86XK_Cut),n(`Delete`,A.XK_Delete,A.XK_KP_Delete),n(`Insert`,A.XK_Insert,A.XK_KP_Insert),e(`Paste`,A.XF86XK_Paste),e(`Redo`,A.XK_Redo),e(`Undo`,A.XK_Undo),e(`Cancel`,A.XK_Cancel),e(`ContextMenu`,A.XK_Menu),e(`Escape`,A.XK_Escape),e(`Execute`,A.XK_Execute),e(`Find`,A.XK_Find),e(`Help`,A.XK_Help),e(`Pause`,A.XK_Pause),e(`Select`,A.XK_Select),e(`ZoomIn`,A.XF86XK_ZoomIn),e(`ZoomOut`,A.XF86XK_ZoomOut),e(`BrightnessDown`,A.XF86XK_MonBrightnessDown),e(`BrightnessUp`,A.XF86XK_MonBrightnessUp),e(`Eject`,A.XF86XK_Eject),e(`LogOff`,A.XF86XK_LogOff),e(`Power`,A.XF86XK_PowerOff),e(`PowerOff`,A.XF86XK_PowerDown),e(`PrintScreen`,A.XK_Print),e(`Hibernate`,A.XF86XK_Hibernate),e(`Standby`,A.XF86XK_Standby),e(`WakeUp`,A.XF86XK_WakeUp),e(`AllCandidates`,A.XK_MultipleCandidate),e(`Alphanumeric`,A.XK_Eisu_toggle),e(`CodeInput`,A.XK_Codeinput),e(`Compose`,A.XK_Multi_key),e(`Convert`,A.XK_Henkan),e(`GroupFirst`,A.XK_ISO_First_Group),e(`GroupLast`,A.XK_ISO_Last_Group),e(`GroupNext`,A.XK_ISO_Next_Group),e(`GroupPrevious`,A.XK_ISO_Prev_Group),e(`NonConvert`,A.XK_Muhenkan),e(`PreviousCandidate`,A.XK_PreviousCandidate),e(`SingleCandidate`,A.XK_SingleCandidate),e(`HangulMode`,A.XK_Hangul),e(`HanjaMode`,A.XK_Hangul_Hanja),e(`JunjaMode`,A.XK_Hangul_Jeonja),e(`Eisu`,A.XK_Eisu_toggle),e(`Hankaku`,A.XK_Hankaku),e(`Hiragana`,A.XK_Hiragana),e(`HiraganaKatakana`,A.XK_Hiragana_Katakana),e(`KanaMode`,A.XK_Kana_Shift),e(`KanjiMode`,A.XK_Kanji),e(`Katakana`,A.XK_Katakana),e(`Romaji`,A.XK_Romaji),e(`Zenkaku`,A.XK_Zenkaku),e(`ZenkakuHankaku`,A.XK_Zenkaku_Hankaku),e(`F1`,A.XK_F1),e(`F2`,A.XK_F2),e(`F3`,A.XK_F3),e(`F4`,A.XK_F4),e(`F5`,A.XK_F5),e(`F6`,A.XK_F6),e(`F7`,A.XK_F7),e(`F8`,A.XK_F8),e(`F9`,A.XK_F9),e(`F10`,A.XK_F10),e(`F11`,A.XK_F11),e(`F12`,A.XK_F12),e(`F13`,A.XK_F13),e(`F14`,A.XK_F14),e(`F15`,A.XK_F15),e(`F16`,A.XK_F16),e(`F17`,A.XK_F17),e(`F18`,A.XK_F18),e(`F19`,A.XK_F19),e(`F20`,A.XK_F20),e(`F21`,A.XK_F21),e(`F22`,A.XK_F22),e(`F23`,A.XK_F23),e(`F24`,A.XK_F24),e(`F25`,A.XK_F25),e(`F26`,A.XK_F26),e(`F27`,A.XK_F27),e(`F28`,A.XK_F28),e(`F29`,A.XK_F29),e(`F30`,A.XK_F30),e(`F31`,A.XK_F31),e(`F32`,A.XK_F32),e(`F33`,A.XK_F33),e(`F34`,A.XK_F34),e(`F35`,A.XK_F35),e(`Close`,A.XF86XK_Close),e(`MailForward`,A.XF86XK_MailForward),e(`MailReply`,A.XF86XK_Reply),e(`MailSend`,A.XF86XK_Send),e(`MediaFastForward`,A.XF86XK_AudioForward),e(`MediaPause`,A.XF86XK_AudioPause),e(`MediaPlay`,A.XF86XK_AudioPlay),e(`MediaRecord`,A.XF86XK_AudioRecord),e(`MediaRewind`,A.XF86XK_AudioRewind),e(`MediaStop`,A.XF86XK_AudioStop),e(`MediaTrackNext`,A.XF86XK_AudioNext),e(`MediaTrackPrevious`,A.XF86XK_AudioPrev),e(`New`,A.XF86XK_New),e(`Open`,A.XF86XK_Open),e(`Print`,A.XK_Print),e(`Save`,A.XF86XK_Save),e(`SpellCheck`,A.XF86XK_Spell),e(`AudioVolumeDown`,A.XF86XK_AudioLowerVolume),e(`AudioVolumeUp`,A.XF86XK_AudioRaiseVolume),e(`AudioVolumeMute`,A.XF86XK_AudioMute),e(`MicrophoneVolumeMute`,A.XF86XK_AudioMicMute),e(`LaunchApplication1`,A.XF86XK_MyComputer),e(`LaunchApplication2`,A.XF86XK_Calculator),e(`LaunchCalendar`,A.XF86XK_Calendar),e(`LaunchMail`,A.XF86XK_Mail),e(`LaunchMediaPlayer`,A.XF86XK_AudioMedia),e(`LaunchMusicPlayer`,A.XF86XK_Music),e(`LaunchPhone`,A.XF86XK_Phone),e(`LaunchScreenSaver`,A.XF86XK_ScreenSaver),e(`LaunchSpreadsheet`,A.XF86XK_Excel),e(`LaunchWebBrowser`,A.XF86XK_WWW),e(`LaunchWebCam`,A.XF86XK_WebCam),e(`LaunchWordProcessor`,A.XF86XK_Word),e(`BrowserBack`,A.XF86XK_Back),e(`BrowserFavorites`,A.XF86XK_Favorites),e(`BrowserForward`,A.XF86XK_Forward),e(`BrowserHome`,A.XF86XK_HomePage),e(`BrowserRefresh`,A.XF86XK_Refresh),e(`BrowserSearch`,A.XF86XK_Search),e(`BrowserStop`,A.XF86XK_Stop),e(`Dimmer`,A.XF86XK_BrightnessAdjust),e(`MediaAudioTrack`,A.XF86XK_AudioCycleTrack),e(`RandomToggle`,A.XF86XK_AudioRandomPlay),e(`SplitScreenToggle`,A.XF86XK_SplitScreen),e(`Subtitle`,A.XF86XK_Subtitle),e(`VideoModeNext`,A.XF86XK_Next_VMode),n(`=`,A.XK_equal,A.XK_KP_Equal),n(`+`,A.XK_plus,A.XK_KP_Add),n(`-`,A.XK_minus,A.XK_KP_Subtract),n(`*`,A.XK_asterisk,A.XK_KP_Multiply),n(`/`,A.XK_slash,A.XK_KP_Divide),n(`.`,A.XK_period,A.XK_KP_Decimal),n(`,`,A.XK_comma,A.XK_KP_Separator),n(`0`,A.XK_0,A.XK_KP_0),n(`1`,A.XK_1,A.XK_KP_1),n(`2`,A.XK_2,A.XK_KP_2),n(`3`,A.XK_3,A.XK_KP_3),n(`4`,A.XK_4,A.XK_KP_4),n(`5`,A.XK_5,A.XK_KP_5),n(`6`,A.XK_6,A.XK_KP_6),n(`7`,A.XK_7,A.XK_KP_7),n(`8`,A.XK_8,A.XK_KP_8),n(`9`,A.XK_9,A.XK_KP_9)})();var Me={8:`Backspace`,9:`Tab`,10:`NumpadClear`,13:`Enter`,16:`ShiftLeft`,17:`ControlLeft`,18:`AltLeft`,19:`Pause`,20:`CapsLock`,21:`Lang1`,25:`Lang2`,27:`Escape`,28:`Convert`,29:`NonConvert`,32:`Space`,33:`PageUp`,34:`PageDown`,35:`End`,36:`Home`,37:`ArrowLeft`,38:`ArrowUp`,39:`ArrowRight`,40:`ArrowDown`,41:`Select`,44:`PrintScreen`,45:`Insert`,46:`Delete`,47:`Help`,48:`Digit0`,49:`Digit1`,50:`Digit2`,51:`Digit3`,52:`Digit4`,53:`Digit5`,54:`Digit6`,55:`Digit7`,56:`Digit8`,57:`Digit9`,91:`MetaLeft`,92:`MetaRight`,93:`ContextMenu`,95:`Sleep`,96:`Numpad0`,97:`Numpad1`,98:`Numpad2`,99:`Numpad3`,100:`Numpad4`,101:`Numpad5`,102:`Numpad6`,103:`Numpad7`,104:`Numpad8`,105:`Numpad9`,106:`NumpadMultiply`,107:`NumpadAdd`,108:`NumpadDecimal`,109:`NumpadSubtract`,110:`NumpadDecimal`,111:`NumpadDivide`,112:`F1`,113:`F2`,114:`F3`,115:`F4`,116:`F5`,117:`F6`,118:`F7`,119:`F8`,120:`F9`,121:`F10`,122:`F11`,123:`F12`,124:`F13`,125:`F14`,126:`F15`,127:`F16`,128:`F17`,129:`F18`,130:`F19`,131:`F20`,132:`F21`,133:`F22`,134:`F23`,135:`F24`,144:`NumLock`,145:`ScrollLock`,166:`BrowserBack`,167:`BrowserForward`,168:`BrowserRefresh`,169:`BrowserStop`,170:`BrowserSearch`,171:`BrowserFavorites`,172:`BrowserHome`,173:`AudioVolumeMute`,174:`AudioVolumeDown`,175:`AudioVolumeUp`,176:`MediaTrackNext`,177:`MediaTrackPrevious`,178:`MediaStop`,179:`MediaPlayPause`,180:`LaunchMail`,181:`MediaSelect`,182:`LaunchApp1`,183:`LaunchApp2`,225:`AltRight`},Ne={Backspace:`Backspace`,AltLeft:`Alt`,AltRight:`Alt`,CapsLock:`CapsLock`,ContextMenu:`ContextMenu`,ControlLeft:`Control`,ControlRight:`Control`,Enter:`Enter`,MetaLeft:`Meta`,MetaRight:`Meta`,ShiftLeft:`Shift`,ShiftRight:`Shift`,Tab:`Tab`,Delete:`Delete`,End:`End`,Help:`Help`,Home:`Home`,Insert:`Insert`,PageDown:`PageDown`,PageUp:`PageUp`,ArrowDown:`ArrowDown`,ArrowLeft:`ArrowLeft`,ArrowRight:`ArrowRight`,ArrowUp:`ArrowUp`,NumLock:`NumLock`,NumpadBackspace:`Backspace`,NumpadClear:`Clear`,Escape:`Escape`,F1:`F1`,F2:`F2`,F3:`F3`,F4:`F4`,F5:`F5`,F6:`F6`,F7:`F7`,F8:`F8`,F9:`F9`,F10:`F10`,F11:`F11`,F12:`F12`,F13:`F13`,F14:`F14`,F15:`F15`,F16:`F16`,F17:`F17`,F18:`F18`,F19:`F19`,F20:`F20`,F21:`F21`,F22:`F22`,F23:`F23`,F24:`F24`,F25:`F25`,F26:`F26`,F27:`F27`,F28:`F28`,F29:`F29`,F30:`F30`,F31:`F31`,F32:`F32`,F33:`F33`,F34:`F34`,F35:`F35`,PrintScreen:`PrintScreen`,ScrollLock:`ScrollLock`,Pause:`Pause`,BrowserBack:`BrowserBack`,BrowserFavorites:`BrowserFavorites`,BrowserForward:`BrowserForward`,BrowserHome:`BrowserHome`,BrowserRefresh:`BrowserRefresh`,BrowserSearch:`BrowserSearch`,BrowserStop:`BrowserStop`,Eject:`Eject`,LaunchApp1:`LaunchMyComputer`,LaunchApp2:`LaunchCalendar`,LaunchMail:`LaunchMail`,MediaPlayPause:`MediaPlay`,MediaStop:`MediaStop`,MediaTrackNext:`MediaTrackNext`,MediaTrackPrevious:`MediaTrackPrevious`,Power:`Power`,Sleep:`Sleep`,AudioVolumeDown:`AudioVolumeDown`,AudioVolumeMute:`AudioVolumeMute`,AudioVolumeUp:`AudioVolumeUp`,WakeUp:`WakeUp`},M={isMac:function(){return/Mac|iPod|iPhone|iPad/.test(navigator.platform)},isIOS:function(){return/iPod|iPhone|iPad/.test(navigator.platform)},isWindows:function(){return/Win/.test(navigator.platform)},isLinux:function(){return/Linux/.test(navigator.platform)},isMacDesktop:_e,hasTextInput:function(){return typeof window.TextEvent==`function`},isChrome:function(){return(navigator.userAgentData&&navigator.userAgentData.brands||[]).some(e=>/Chromium|Google Chrome/.test(e.brand))?!0:!!window.chrome&&(!!window.chrome.webstore||!!window.chrome.runtime)},isSafari:function(){return/Safari/.test(navigator.userAgent)&&!/Chrome/.test(navigator.userAgent)}},Pe=[`ControlLeft`,`ControlRight`,`MetaLeft`,`MetaRight`];function Fe(e){return e===A.XK_Control_L||e===A.XK_Control_R||e===A.XK_Alt_L||e===A.XK_Alt_R||e===A.XK_Super_L||e===A.XK_Super_R||e===A.XK_Meta_L||e===A.XK_Meta_R}var Ie={[A.XK_Shift_L]:`Shift`,[A.XK_Shift_R]:`Shift`,[A.XK_Control_L]:`Control`,[A.XK_Control_R]:`Control`,[A.XK_Alt_L]:`Alt`,[A.XK_Alt_R]:`Alt`,[A.XK_Meta_L]:`Meta`,[A.XK_Meta_R]:`Meta`,[A.XK_Super_L]:`Meta`,[A.XK_Super_R]:`Meta`,[A.XK_ISO_Level3_Shift]:`Alt`,[A.XK_Mode_switch]:`Alt`},N={[A.XK_KP_Space]:A.XK_space,[A.XK_KP_Enter]:A.XK_Return,[A.XK_KP_Equal]:A.XK_equal,[A.XK_KP_Multiply]:A.XK_asterisk,[A.XK_KP_Add]:A.XK_plus,[A.XK_KP_Separator]:A.XK_comma,[A.XK_KP_Subtract]:A.XK_minus,[A.XK_KP_Decimal]:A.XK_period,[A.XK_KP_Divide]:A.XK_slash,[A.XK_KP_0]:A.XK_0,[A.XK_KP_1]:A.XK_1,[A.XK_KP_2]:A.XK_2,[A.XK_KP_3]:A.XK_3,[A.XK_KP_4]:A.XK_4,[A.XK_KP_5]:A.XK_5,[A.XK_KP_6]:A.XK_6,[A.XK_KP_7]:A.XK_7,[A.XK_KP_8]:A.XK_8,[A.XK_KP_9]:A.XK_9},Le={[A.XK_KP_Home]:A.XK_Home,[A.XK_KP_Up]:A.XK_Up,[A.XK_KP_Page_Up]:A.XK_Page_Up,[A.XK_KP_Prior]:A.XK_Prior,[A.XK_KP_Left]:A.XK_Left,[A.XK_KP_Begin]:A.XK_Clear,[A.XK_KP_Right]:A.XK_Right,[A.XK_KP_End]:A.XK_End,[A.XK_KP_Down]:A.XK_Down,[A.XK_KP_Page_Down]:A.XK_Page_Down,[A.XK_KP_Next]:A.XK_Next,[A.XK_KP_Insert]:A.XK_Insert,[A.XK_KP_Delete]:A.XK_Delete,[A.XK_KP_Enter]:A.XK_Return},P={getKeyCode:function(e){if(e.code){switch(e.code){case`OSLeft`:return`MetaLeft`;case`OSRight`:return`MetaRight`}return e.code}if(e.keyCode in Me){let t=Me[e.keyCode];if(M.isMac()&&t===`ContextMenu`&&(t=`MetaRight`),e.location===2)switch(t){case`ShiftLeft`:return`ShiftRight`;case`ControlLeft`:return`ControlRight`;case`AltLeft`:return`AltRight`}if(e.location===3)switch(t){case`Delete`:return`NumpadDecimal`;case`Insert`:return`Numpad0`;case`End`:return`Numpad1`;case`ArrowDown`:return`Numpad2`;case`PageDown`:return`Numpad3`;case`ArrowLeft`:return`Numpad4`;case`ArrowRight`:return`Numpad6`;case`Home`:return`Numpad7`;case`ArrowUp`:return`Numpad8`;case`PageUp`:return`Numpad9`;case`Enter`:return`NumpadEnter`}return t}return`Unidentified`},getKey:function(e){if(e.key!==void 0&&e.key!==`Unidentified`&&e.key!==`Dead`){switch(e.key){case`OS`:return`Meta`;case`LaunchMyComputer`:return`LaunchApplication1`;case`LaunchCalculator`:return`LaunchApplication2`;case`UIKeyInputUpArrow`:return`ArrowUp`;case`UIKeyInputDownArrow`:return`ArrowDown`;case`UIKeyInputLeftArrow`:return`ArrowLeft`;case`UIKeyInputRightArrow`:return`ArrowRight`;case`UIKeyInputEscape`:return`Escape`}return e.key===`\0`&&P.getKeyCode(e)===`NumpadDecimal`?`Delete`:e.key}let t=P.getKeyCode(e);return t in Ne?Ne[t]:e.charCode?String.fromCharCode(e.charCode):`Unidentified`},getKeysym:function(e){let t=P.getKey(e);if(t===`Unidentified`)return null;if(t in je){let n=e.location;if((M.isSafari()&&t===`Meta`&&n===0||M.isChrome()&&t===`Meta`&&n===0&&P.getKeyCode(e)===`MetaRight`)&&(n=2),t===`Clear`&&n===3&&P.getKeyCode(e)===`NumLock`&&(n=0),(n===void 0||n>3)&&(n=0),t===`Meta`&&(M.isMac()||M.isIOS())){let t=P.getKeyCode(e);if(t===`AltLeft`)return A.XK_Meta_L;if(t===`AltRight`)return A.XK_Meta_R}if(t===`Clear`&&P.getKeyCode(e)===`NumLock`)return A.XK_Num_Lock;if(M.isWindows())switch(t){case`Zenkaku`:case`Hankaku`:return A.XK_Zenkaku_Hankaku;case`Romaji`:case`KanaMode`:return A.XK_Romaji}return je[t][n]}if(t.length!==1)return null;let n=t.charCodeAt();return n?j.lookup(n):null},getKeysymFromCode:function(e){if(!e)return null;if(/^Key[A-Z]$/.test(e))return j.lookup(e.charCodeAt(3)+32);if(/^Digit[0-9]$/.test(e))return j.lookup(e.charCodeAt(5));let t=/^F([1-9]|1[0-2])$/.exec(e);if(t)return A.XK_F1+(parseInt(t[1],10)-1);let n={Minus:45,Equal:61,BracketLeft:91,BracketRight:93,Backslash:92,Semicolon:59,Quote:39,Backquote:96,Comma:44,Period:46,Slash:47,Space:32};if(e in n)return j.lookup(n[e]);let r={Tab:A.XK_Tab,Enter:A.XK_Return,Backspace:A.XK_BackSpace,Delete:A.XK_Delete,Escape:A.XK_Escape,Insert:A.XK_Insert,Home:A.XK_Home,End:A.XK_End,PageUp:A.XK_Page_Up,PageDown:A.XK_Page_Down,ArrowUp:A.XK_Up,ArrowDown:A.XK_Down,ArrowLeft:A.XK_Left,ArrowRight:A.XK_Right};return e in r?r[e]:null}},F=function(e){e.stopPropagation(),e.preventDefault()},Re=class e{constructor(t,n,r=!1,i=0,a=!1,o=null){this.element=t,this.send=n,this.sendMotion=null,this._pointerSeq=0,this._isSidebarOpen=!1,this.isSharedMode=r,this.controllerSlot=o,this.playerIndex=i,this.cursorDiv=document.createElement(`canvas`),this.cursorDiv.style.position=`fixed`,this.cursorDiv.style.pointerEvents=`none`,this.cursorDiv.style.zIndex=`999999`,this.cursorDiv.style.display=`none`,this.cursorDiv.style.left=`0px`,this.cursorDiv.style.top=`0px`,this.cursorImg=this.cursorDiv.getContext(`2d`),document.body.appendChild(this.cursorDiv),this.cursorHotspot={x:0,y:0},this._cursorImageBitmap=null,this._rawHotspotX=0,this._rawHotspotY=0,this.use_browser_cursors=!1,this._latestMouseX=0,this._latestMouseY=0,this.useCssScaling=a,this._streamDensity=null,this.m=null,this._layout=null,this._anchorX=null,this._anchorY=null,this._chromeInsetX=null,this._chromeInsetY=null,this._sampleClientX=-1e9,this._sampleClientY=-1e9,this._sampleAnchorX=NaN,this._sampleAnchorY=NaN,this._geometryTimer=null,this.buttonMask=0,this.gamepadManager=null,this.x=0,this.y=0,this._relCarryX=0,this._relCarryY=0,this._pointerScaleFrame=null,this._pendingMove=null,this._moveFlushScheduled=!1,this.onmenuhotkey=null,this.gamingMode=!1,this.shortcutsEnabled=!0,this._escapePresses=0,this._lastEscapeAt=0,this.ongamingmode=null,this.onnotice=null,this.onfullscreenhotkey=this.enterFullscreen,this.ongaminghotkey=this.toggleGamingMode,this.ongamepadhotkey=null,this.ongamepadconnected=null,this.ongamepaddisconnected=null,this.listeners=[],this.listeners_context=[],this._queue=new y,this._allowTrackpadScrolling=!0,this._allowThreshold=!0,this._smallestDeltaY=1e4,this._smallestLineDeltaY=1e4,this._wheelThreshold=100,this._scrollMagnitude=10,this._wheelAccumY=0,this._wheelDirY=null,this._wheelAccumX=0,this._wheelDirX=null,this._lastWheelEventTs=0,this.cursorScaleFactor=null,this._cursorBase64Data=null,this._guacKeyboardID=e._nextGuacID++,this._EVENT_MARKER=`_GUAC_KEYBOARD_HANDLED_BY_`+this._guacKeyboardID,this._keyDownList={},this._keyHeartbeatTimer=null,this._KEY_HEARTBEAT_INTERVAL=100,this._altGrArmed=!1,this._altGrTimeout=null,this._altGrCtrlTime=0,this._macCmdSwapped=!1,this._isSynth=!1,this._altKeysymByCode=new Map,this.isComposing=!1,this.compositionString=``,this._pendingChord=null,this._momentaryChordMods=new Set,this._momentaryChordModsTimer=null,this._chordKeySent=!1,this._lastTextInputCommit=null,this.keyboardInputAssist=document.getElementById(`keyboard-input-assist`),this._assistTyped=``,this._assistComposing=!1,this._activeTouches=new Map,this._activeTouchIdentifier=null,this._isTwoFingerGesture=!1,this._MIN_SWIPE_DISTANCE=30,this._MAX_SWIPE_DURATION=600,this._VERTICAL_SWIPE_RATIO=1.5,this._SCROLL_PIXELS_PER_TICK=40,this._MAX_SCROLL_MAGNITUDE=8,this._TAP_THRESHOLD_DISTANCE_SQ=100,this._TAP_MAX_DURATION=250,this._trackpadMode=!1,this._trackpadTouches=new Map,this._trackpadLastTapTime=0,this._trackpadGestureMode=null,this._trackpadTapTimeout=null,this._trackpadLastScrollCentroid=null,this._touchScrollLastCentroid=null,this.inputAttached=!1}setSharedMode(e){this.isSharedMode=!!e}updateControllerSlot(e){this.controllerSlot!==e&&(console.log(`Input class: Controller slot updated to: ${e}`),this.controllerSlot=e)}_handleVisibilityMessage(e){if(e.origin!==window.location.origin)return;let t=e.data;typeof t==`object`&&t&&t.type===`sidebarVisibilityChanged`&&(this._isSidebarOpen=!!t.isOpen)}static _asksRawMotion(){return e.rawPointerMotion&&!e._rawMotionRefused}_drawAndScaleCursor(){if(!this._cursorImageBitmap)return;let e=this._cursorDensity(),t=this._cursorImageBitmap;this.cursorDiv.width=t.width,this.cursorDiv.height=t.height,this.cursorDiv.style.width=`${t.width/e}px`,this.cursorDiv.style.height=`${t.height/e}px`,this.cursorImg.clearRect(0,0,t.width,t.height),this.cursorImg.drawImage(t,0,0),this.cursorHotspot.x=this._rawHotspotX/e,this.cursorHotspot.y=this._rawHotspotY/e,this._updateCursorPosition(this._latestMouseX,this._latestMouseY)}_handleOutsideClick(e){!this.use_browser_cursors&&!this.element.contains(e.target)&&(this.cursorDiv.style.display=`none`)}_updateCursorPosition(e,t){if(this.cursorDiv.style.display!==`none`){let n=e-this.cursorHotspot.x,r=t-this.cursorHotspot.y;this.cursorDiv.style.transform=`translate(${n}px, ${r}px)`}}_cursorImageSetFunction(){if(e._cursorImageSetFn===void 0&&(e._cursorImageSetFn=null,typeof CSS<`u`&&CSS.supports)){for(let t of[`image-set`,`-webkit-image-set`])if(CSS.supports(`cursor`,`${t}(url("data:image/png;base64,") 2x) 0 0, default`)){e._cursorImageSetFn=t;break}}return e._cursorImageSetFn}_updateBrowserCursor(){if(!this._cursorBase64Data){this.element.style.setProperty(`cursor`,`none`,`important`);return}let e=`url("data:image/png;base64,${this._cursorBase64Data}")`,t=this._cursorDensity(),n=`${e} ${this._rawHotspotX} ${this._rawHotspotY}, default`,r=t===1?null:this._cursorImageSetFunction();r&&(n=`${r}(${e} ${t}x) ${Math.round(this._rawHotspotX/t)} ${Math.round(this._rawHotspotY/t)}, default`),this.element.style.setProperty(`cursor`,n,`important`)}_cursorBitmapFromBase64(e){let t=Uint8Array.from(atob(e),e=>e.charCodeAt(0));return createImageBitmap(new Blob([t],{type:`image/png`}))}async updateServerCursor(e){if(!e.curdata||parseInt(e.handle,10)===0||this._trackpadMode){this._cursorImageBitmap=null,this._cursorBase64Data=null,this.cursorDiv.style.display=`none`,this.use_browser_cursors&&this.element.style.setProperty(`cursor`,`none`,`important`);return}if(this._rawHotspotX=parseInt(e.hotx)||0,this._rawHotspotY=parseInt(e.hoty)||0,this._cursorBase64Data=e.curdata,!this.inputAttached){this.cursorDiv.style.display=`none`,this.element.style.cursor=`auto`;return}this.use_browser_cursors?(this.cursorDiv.style.display=`none`,this._updateBrowserCursor()):(this._cursorImageBitmap=await this._cursorBitmapFromBase64(this._cursorBase64Data),this.element.style.setProperty(`cursor`,`none`,`important`),this.cursorDiv.style.display=`block`,this._drawAndScaleCursor())}setSynth(e){console.log(`Input: Synthetic mode ${e?`enabled`:`disabled`}.`),this._isSynth=e}updateCssScaling(e){this.useCssScaling!==e&&(console.log(`Input: Updating useCssScaling from ${this.useCssScaling} to ${e}`),this.useCssScaling=e,this._windowMath(),this._drawAndScaleCursor())}_sendKeyEvent(e,t,n){if(e===null)return;let r=e;if(N.hasOwnProperty(e)?r=N[e]:Le.hasOwnProperty(e)&&(r=Le[e]),n)this._keyDownList[t]=r;else{if(!(t in this._keyDownList))return;r=this._keyDownList[t],delete this._keyDownList[t]}this.send((n?`kd,`:`ku,`)+r),n?(this._noteChordKey(r),this._startKeyHeartbeat()):Object.keys(this._keyDownList).length===0&&this._stopKeyHeartbeat()}_startKeyHeartbeat(){this._keyHeartbeatTimer===null&&(this._keyHeartbeatTimer=setInterval(()=>{let e=Object.values(this._keyDownList);if(e.length===0){this._stopKeyHeartbeat();return}this.send(`kh,`+e.join(`,`))},this._KEY_HEARTBEAT_INTERVAL))}_stopKeyHeartbeat(){this._keyHeartbeatTimer!==null&&(clearInterval(this._keyHeartbeatTimer),this._keyHeartbeatTimer=null)}_sendMomentaryKey(e){e!==null&&(this._noteChordKey(e),this.send(`kd,`+e),this.send(`ku,`+e))}_noteChordKey(e){!Fe(e)&&this._chordModifierHeld()&&(this._chordKeySent=!0)}_focusCompositionHost(){let e=this.element;if(!e||typeof e.focus!=`function`)return;let t=document.activeElement;if(!t||t===document.body||t===e||t.tagName!==`INPUT`&&t.tagName!==`TEXTAREA`&&!t.isContentEditable)try{e.focus({preventScroll:!0})}catch{}}_releaseDesyncedModifiers(e){if(!(typeof e.getModifierState!=`function`||this._isSynth)&&!(this.isComposing||e.isComposing||e.keyCode===229||e.key===`Process`)){Ee(e)||this._altKeysymByCode.clear();for(let t in this._keyDownList){let n=this._keyDownList[t],r=k[t],i=Ie[n];(r||i)&&(De(e,r)||De(e,i)||(this._sendKeyEvent(n,t,!1),delete this._keyDownList[t]))}}}resetKeyboard(){this._stopKeyHeartbeat(),clearTimeout(this._altGrTimeout),this._altGrArmed=!1;for(let e in this._keyDownList)this._sendKeyEvent(this._keyDownList[e],e,!1);this._keyDownList={},this._altKeysymByCode.clear()}_onVisibilityChange(){document.visibilityState===`hidden`&&this.resetKeyboard()}_guac_markEvent(e){return!e[this._EVENT_MARKER]&&(e[this._EVENT_MARKER]=!0,!0)}_handleKeyDown(t){if(this._escapeHatch(t)){F(t);return}if(t.ctrlKey&&t.shiftKey&&this.shortcutsEnabled){let e=null;if(t.code===`KeyM`&&!this.gamingMode?e=this.onmenuhotkey:t.code===`KeyF`&&document.fullscreenElement===null?e=this.onfullscreenhotkey:t.code===`KeyX`?e=this.ongaminghotkey:t.code===`KeyG`&&(e=this.ongamepadhotkey),e!==null&&this._guac_markEvent(t)){e.call(this),F(t);return}}if(this._targetHasClass(t.target,we)||!this._guac_markEvent(t))return;this._chordKeySent=!1,this._releaseDesyncedModifiers(t);let n=P.getKeyCode(t);if(n===`CapsLock`&&P.getKey(t)===`CapsLock`){F(t);return}if(n in this._keyDownList){F(t);return}if(this.isComposing||t.isComposing||t.keyCode===229){let e=this._altGrArmed;if((t.ctrlKey||t.altKey||t.metaKey||e)&&!this._composesText(t)){let n=P.getKeysymFromCode(t.code);if(n){if(this.isComposing||t.isComposing)this._pendingChord={keysym:n,ctrl:t.ctrlKey||e,alt:t.altKey,meta:t.metaKey,shift:t.shiftKey,at:performance.now()};else{this._altGrArmed&&(this._altGrArmed=!1,clearTimeout(this._altGrTimeout));let r=this._missingChordModifiers({ctrl:t.ctrlKey||e,alt:t.altKey,meta:t.metaKey,shift:t.shiftKey});this._noteMomentaryChordMods(r);for(let e of r)this.send(`kd,`+e);this._sendMomentaryKey(n);for(let e of r.reverse())this.send(`ku,`+e)}}}F(t);return}let r=P.getKeyCode(t),i=P.getKeysym(t);if(this._altGrArmed&&(this._altGrArmed=!1,clearTimeout(this._altGrTimeout),r===`AltRight`&&t.timeStamp-this._altGrCtrlTime<50?i=A.XK_ISO_Level3_Shift:this._sendKeyEvent(A.XK_Control_L,`ControlLeft`,!0)),i!==null&&!this._composesText(t)&&(t.ctrlKey||t.metaKey||t.altKey)){let e=P.getKey(t);if(typeof e==`string`&&[...e].length===1&&e.codePointAt(0)>127){let e=P.getKeysymFromCode(t.code);e&&(i=e)}}if(r===`Unidentified`&&i){this._sendMomentaryKey(i),F(t);return}if(M.isMac()&&e.macCmdAsCtrl&&ke(t)&&r!==`MetaLeft`&&r!==`MetaRight`&&t.metaKey&&!t.ctrlKey&&!t.altKey&&(this._keyDownList.MetaLeft||this._keyDownList.MetaRight)&&(console.log(`macOS: Cmd+key detected for code '${r}'. Remapping Cmd to Ctrl.`),this._keyDownList.MetaLeft&&this._sendKeyEvent(this._keyDownList.MetaLeft,`MetaLeft`,!1),this._keyDownList.MetaRight&&this._sendKeyEvent(this._keyDownList.MetaRight,`MetaRight`,!1),this._sendKeyEvent(A.XK_Control_L,`ControlLeft`,!0),this._macCmdSwapped=!0),(M.isMac()||M.isIOS())&&ke(t))switch(i){case A.XK_Super_L:e.macCmdAsCtrl&&(i=A.XK_Alt_L);break;case A.XK_Super_R:i=A.XK_Super_L;break;case A.XK_Alt_L:i=A.XK_Mode_switch;break;case A.XK_Alt_R:i=A.XK_ISO_Level3_Shift}if(k[r]===`Alt`&&this._altKeysymByCode.set(r,i),(M.isMac()||M.isIOS())&&ke(t)&&i===A.XK_ISO_Level3_Shift){console.log(`macOS: AltRight pressed, sending ISO_Level3_Shift momentarily`),this._sendMomentaryKey(A.XK_ISO_Level3_Shift),F(t);return}r in this._keyDownList&&(i=this._keyDownList[r]);let a=[A.XK_Zenkaku_Hankaku,A.XK_Eisu_toggle,A.XK_Katakana,A.XK_Hiragana,A.XK_Romaji];if(M.isWindows()&&a.includes(i)){this._sendMomentaryKey(i),F(t);return}if((M.isChrome()||r!==`KeyV`||!t.ctrlKey&&!t.metaKey||t.altKey||this.isComposing)&&F(t),r===`ControlLeft`&&M.isWindows()&&ke(t)&&!(r in this._keyDownList)){this._altGrArmed=!0,this._altGrCtrlTime=t.timeStamp,this._altGrTimeout=setTimeout(()=>{this._altGrArmed=!1,this._sendKeyEvent(A.XK_Control_L,`ControlLeft`,!0)},100);return}if(i!==null&&!k[r]&&(t.ctrlKey||t.altKey||t.metaKey)&&!this._composesText(t)){let e=this._missingChordModifiers({ctrl:t.ctrlKey,alt:t.altKey,meta:t.metaKey&&!this._macCmdSwapped,shift:t.shiftKey});if(e.length>0){this._noteMomentaryChordMods(e);for(let t of e)this.send(`kd,`+t);this._sendKeyEvent(i,r,!0);for(let t of e.reverse())this.send(`ku,`+t);return}}this._sendKeyEvent(i,r,!0)}_escapeHatch(e){if(!this.gamingMode||e.repeat)return!1;let t=performance.now();return(e.code!==`Escape`||t-this._lastEscapeAt>1e3)&&(this._escapePresses=0),this._lastEscapeAt=t,e.code!==`Escape`||(this._escapePresses+=1,this._escapePresses<3)?!1:(this._escapePresses=0,this.toggleGamingMode(),!0)}_handleKeyUp(e){if(this._targetHasClass(e.target,we)||!this._guac_markEvent(e))return;F(e);let t=P.getKeyCode(e);if(t===`CapsLock`&&P.getKey(e)===`CapsLock`)return;if(M.isMac()&&(t===`MetaLeft`||t===`MetaRight`)){console.log(`macOS: Command key ('${t}') released. Cleaning up potentially stuck keys.`);let e=Object.keys(this._keyDownList);for(let t of e)t!==`ShiftLeft`&&t!==`ShiftRight`&&t!==`ControlLeft`&&t!==`ControlRight`&&t!==`AltLeft`&&t!==`AltRight`&&t!==`MetaLeft`&&t!==`MetaRight`&&(console.log(`macOS: Force-releasing stuck key: ${t}`),this._sendKeyEvent(this._keyDownList[t],t,!1));this._macCmdSwapped&&=(console.log(`macOS: Releasing the swapped virtual Ctrl key.`),`ControlLeft`in this._keyDownList&&this._sendKeyEvent(this._keyDownList.ControlLeft,`ControlLeft`,!1),!1)}this._altGrArmed&&(this._altGrArmed=!1,clearTimeout(this._altGrTimeout),this._sendKeyEvent(A.XK_Control_L,`ControlLeft`,!0)),this._altKeysymByCode.delete(t);let n=this._keyDownList[t];this._sendKeyEvent(n,t,!1),M.isWindows()&&(t===`ShiftLeft`||t===`ShiftRight`)&&(`ShiftRight`in this._keyDownList&&this._sendKeyEvent(this._keyDownList.ShiftRight,`ShiftRight`,!1),`ShiftLeft`in this._keyDownList&&this._sendKeyEvent(this._keyDownList.ShiftLeft,`ShiftLeft`,!1))}_updateCompositionText(e){this.compositionString=this._streamTextDiff(this.compositionString,e||``)}_streamTextDiff(e,t){let n=Array.from(e),r=Array.from(t),i=0;for(;i<n.length&&i<r.length&&n[i]===r[i];)i++;let a=n.length-i;for(let e=0;e<a;e++)this._sendMomentaryKey(A.XK_BackSpace);for(let e=i;e<r.length;e++){let t=j.lookup(r[e].codePointAt(0));t&&this._sendMomentaryKey(t)}return t}_compositionStart(e){this._guac_markEvent(e)&&(this.isComposing=!0,this.compositionString=``,this._lastTextInputCommit=null,this._pendingChord=null)}_flushPendingChord(){let e=this._pendingChord;if(this._pendingChord=null,e===null||performance.now()-e.at>500)return;let t=[];e.ctrl&&t.push(A.XK_Control_L),e.alt&&t.push(A.XK_Alt_L),e.meta&&t.push(A.XK_Super_L),e.shift&&t.push(A.XK_Shift_L),this._noteMomentaryChordMods(t);for(let e of t)this.send(`kd,`+e);this.send(`kd,`+e.keysym),this.send(`ku,`+e.keysym);for(let e of t.reverse())this.send(`ku,`+e)}_compositionUpdate(e){this._guac_markEvent(e)&&this.isComposing&&this._updateCompositionText(e.data)}_compositionEnd(e){if(!this._guac_markEvent(e)||!this.isComposing)return;this._pendingChord!==null&&setTimeout(()=>this._flushPendingChord(),0);let t=this._lastTextInputCommit,n=t!==null&&t.data===e.data&&performance.now()-t.at<400;if(M.isLinux()&&M.hasTextInput()||!e.data||n){this._updateCompositionText(``),this.isComposing=!1,this.compositionString=``,this._clearCompositionHostSoon();return}this._updateCompositionText(e.data),this.isComposing=!1,this.compositionString=``,this._clearCompositionHostSoon()}_clearCompositionHostSoon(){setTimeout(()=>{if(this.isComposing)return;let e=this.element;e&&e.tagName===`INPUT`&&e.value&&(e.value=``),this._resetAssist()},0)}_resetAssist(){let e=this.keyboardInputAssist;e&&e.value&&(e.value=``),this._assistTyped=``}_assistCompositionStart(e){this._guac_markEvent(e)&&(this.isComposing=!0,this._assistComposing=!0,this._lastTextInputCommit=null,this._pendingChord=null)}_assistCompositionEnd(e){this._guac_markEvent(e)&&this._assistComposing&&(this._pendingChord!==null&&setTimeout(()=>this._flushPendingChord(),0),this.isComposing=!1,this._assistComposing=!1,this._assistTyped=this._streamTextDiff(this._assistTyped,e.target.value||``),this._clearCompositionHostSoon())}_assistFocusChange(){this._assistComposing&&(this._assistComposing=!1,this.isComposing=!1),this._assistTyped=``}_typeText(e){for(let t of e){let e=j.lookup(t.codePointAt(0));e&&(this.send(`kd,`+e),this.send(`ku,`+e))}}_handleTextInput(e){e.data&&(this._chordEchoPending()||(this._typeText(e.data),this._lastTextInputCommit={data:e.data,at:performance.now()},this._clearCompositionHostSoon()))}_chordModifierHeld(){if(this._momentaryChordMods.size>0)return!0;for(let e in this._keyDownList)if(Fe(this._keyDownList[e]))return!0;return!1}_chordEchoPending(){return!this._chordModifierHeld()||!this._chordKeySent?!1:(this._chordKeySent=!1,!0)}_missingChordModifiers({ctrl:e,alt:t,meta:n,shift:r}){let i=[];return e&&!this._keysymHeld(A.XK_Control_L,A.XK_Control_R)&&i.push(A.XK_Control_L),t&&!this._keysymHeld(A.XK_Alt_L,A.XK_Alt_R)&&i.push(A.XK_Alt_L),n&&!this._keysymHeld(A.XK_Super_L,A.XK_Super_R,A.XK_Meta_L,A.XK_Meta_R)&&i.push(A.XK_Super_L),r&&!this._keysymHeld(A.XK_Shift_L,A.XK_Shift_R)&&i.push(A.XK_Shift_L),i}_noteMomentaryChordMods(e){for(let t of e)this._momentaryChordMods.add(t);clearTimeout(this._momentaryChordModsTimer),this._momentaryChordModsTimer=setTimeout(()=>this._momentaryChordMods.clear(),250)}_composesText(e){if(!Oe(P.getKey(e)))return!1;for(let e of Pe)if(e in this._keyDownList)return!1;return(e.ctrlKey||e.metaKey)&&!(typeof e.getModifierState==`function`&&e.getModifierState(`AltGraph`))?!1:Ee(e)&&this._altShiftsLevel(e)}_altShiftsLevel(e){if(this._altKeysymByCode.size===0)return typeof e.getModifierState==`function`&&e.getModifierState(`AltGraph`);for(let e of this._altKeysymByCode.values())if(e===A.XK_Alt_L||e===A.XK_Alt_R)return!1;return!0}_keysymHeld(...e){for(let t in this._keyDownList)if(e.includes(this._keyDownList[t]))return!0;return!1}_handleMobileInput(e){let t=e.target;if(this._chordEchoPending()){this._resetAssist();return}let n=t.value||``;(!this.isComposing||n)&&(this._assistTyped=this._streamTextDiff(this._assistTyped,n),this.isComposing||this._resetAssist())}_mouseButtonMovement(e){if(this.buttonMask===0&&e.target!==this.element)return;this.inputAttached&&!this.use_browser_cursors&&(this.cursorDiv.style.display=`block`,this.element.style.setProperty(`cursor`,`none`,`important`)),this._noteScreenAnchor(e);let t=e.clientX,n=e.clientY;if(e.getPredictedEvents&&typeof e.getPredictedEvents==`function`){let r=e.getPredictedEvents();if(r.length>0){let e=r[r.length-1];t=e.clientX,n=e.clientY}}if(this.inputAttached&&!this.use_browser_cursors&&this._updateCursorPosition(t,n),this._latestMouseX=t,this._latestMouseY=n,this._trackpadMode)return;let r=this._inputDpr(),i=+(e.type===`mousedown`||e.type===`pointerdown`);i&&this._releaseDesyncedModifiers(e),i&&e.target===this.element&&document.activeElement!==this.element&&this._focusCompositionHost();var a=`m`;let o=0,s=0,c=document.getElementById(`videoCanvas`),l=document.getElementById(`stream`);if((e.type===`mousedown`||e.type===`mouseup`||e.type===`pointerdown`||e.type===`pointerup`||e.type===`pointercancel`)&&(e.button===1&&e.preventDefault(),(e.button===3||e.button===4)&&e.preventDefault()),i&&e.button===0&&e.ctrlKey&&e.shiftKey&&this.shortcutsEnabled){let t=this._streamLockTargets().includes(e.target)?e.target:this.element,n=()=>this._requestPointerLock(t,n,e=>console.error(`Pointer lock failed:`,e));n(),e.preventDefault();return}if(i&&e.button===0&&this.gamingMode&&this._armPointerLock(),this._isStreamLocked())a=`m2`,o=e.movementX||0,s=e.movementY||0;else if((e.type===`mousemove`||e.type===`pointermove`||e.type===`mousedown`||e.type===`mouseup`||e.type===`pointerdown`||e.type===`pointerup`)&&!this._applySinkCoordinates(e.clientX,e.clientY,c,l,e.screenX,e.screenY)){if(this.m||this._windowMath(),this.m){let t=this._clientToServerX(e.clientX)*r,n=this._clientToServerY(e.clientY)*r;this._mapToLayout(t,n,this.m.mouseMultiX*r,this.m.mouseMultiY*r,e.screenX,e.screenY)||(this.x=Math.round(t),this.y=Math.round(n))}else this.x=0,this.y=0}if(e.type===`mousedown`||e.type===`mouseup`||(e.type===`pointerdown`||e.type===`pointerup`)&&e.button>=0){var u=1<<e.button;i?this.buttonMask|=u:this.buttonMask&=~u}else e.target===this.element&&(this.buttonMask=Te(e.buttons));let d=a===`m2`?o:this.x,f=a===`m2`?s:this.y;if(e.type===`mousemove`||e.type===`pointermove`)this._queueCoalescedMouseMove(a,d,f,this.buttonMask);else if(this._flushCoalescedMouseMove(),a===`m2`){let e=this._relativeToServer(d,f);this._sendPointer([`m2`,e[0],e[1],this.buttonMask,0],!1)}else this._sendPointer([`m`,d,f,this.buttonMask,0],!1)}_queueCoalescedMouseMove(e,t,n,r){e===`m2`?this._pendingMove&&this._pendingMove.mtype===`m2`?(this._pendingMove.x+=t,this._pendingMove.y+=n,this._pendingMove.buttonMask=r):(this._flushCoalescedMouseMove(),this._pendingMove={mtype:`m2`,x:t,y:n,buttonMask:r}):(this._pendingMove&&this._pendingMove.mtype!==`m`&&this._flushCoalescedMouseMove(),this._pendingMove={mtype:`m`,x:t,y:n,buttonMask:r}),this._moveFlushScheduled||(this._moveFlushScheduled=!0,(window.requestAnimationFrame?window.requestAnimationFrame.bind(window):e=>setTimeout(e,16))(()=>{this._moveFlushScheduled=!1,this._flushCoalescedMouseMove()}))}_flushCoalescedMouseMove(){let e=this._pendingMove;if(e){if(this._pendingMove=null,e.mtype===`m2`){let t=this._relativeToServer(e.x,e.y);if(t[0]===0&&t[1]===0)return;this._sendPointer([e.mtype,t[0],t[1],e.buttonMask,0],!0);return}this._sendPointer([e.mtype,e.x,e.y,e.buttonMask,0],!0)}}_sendPointer(e,t){this._pointerSeq+=1;let n=e.join(`,`)+`,`+this._pointerSeq;(t&&this.sendMotion||this.send)(n)}_handlePointerDown(e){e.pointerType===`pen`&&(e.preventDefault(),this._mouseButtonMovement(e))}_handlePointerMove(e){e.pointerType===`pen`&&this._mouseButtonMovement(e)}_handlePointerUp(e){e.pointerType===`pen`&&this._mouseButtonMovement(e)}_handleTrackpadEvent(e){if(this._targetHasClass(e.target,we))return;e.preventDefault(),e.stopPropagation();let t=Date.now(),n=e.type,r=e.changedTouches;if(n===`touchstart`){this._trackpadTapTimeout&&=(clearTimeout(this._trackpadTapTimeout),null);for(let e of r)this._trackpadTouches.set(e.identifier,{id:e.identifier,startX:e.clientX,startY:e.clientY,lastX:e.clientX,lastY:e.clientY,moved:!1});let e=this._trackpadTouches.size;if(e===1)t-this._trackpadLastTapTime<300?(this._trackpadGestureMode=`dragging`,this.buttonMask|=1,this._sendPointer([`m2`,0,0,this.buttonMask,0],!1),this._trackpadLastTapTime=0):this._trackpadGestureMode=`moving`;else if(e===2){this._trackpadGestureMode=`scrolling`,this._trackpadLastTapTime=0;let e=Array.from(this._trackpadTouches.values());this._trackpadLastScrollCentroid={x:(e[0].lastX+e[1].lastX)/2,y:(e[0].lastY+e[1].lastY)/2}}}else if(n===`touchmove`){let e=!1;for(let t of this._trackpadTouches.values()){if(!t.moved){let e=Array.from(r).find(e=>e.identifier===t.id)||t;if(e){let n=e.clientX-t.startX,r=e.clientY-t.startY;n*n+r*r>this._TAP_THRESHOLD_DISTANCE_SQ&&(t.moved=!0)}}t.moved&&(e=!0)}if(e&&(this._trackpadLastTapTime=0),this._trackpadGestureMode===`moving`||this._trackpadGestureMode===`dragging`){let e=this._trackpadTouches.values().next().value;if(e){let t=Array.from(r).find(t=>t.identifier===e.id);if(t){let n=this._relativeToServer(t.clientX-e.lastX,t.clientY-e.lastY);(n[0]!==0||n[1]!==0)&&this._sendPointer([`m2`,n[0],n[1],this.buttonMask,0],!0),e.lastX=t.clientX,e.lastY=t.clientY}}}else if(this._trackpadGestureMode===`scrolling`){let e=Array.from(this._trackpadTouches.values());if(e.length===2){for(let e of r){let t=this._trackpadTouches.get(e.identifier);t&&(t.lastX=e.clientX,t.lastY=e.clientY)}let t=(e[0].lastX+e[1].lastX)/2,n=(e[0].lastY+e[1].lastY)/2;if(this._trackpadLastScrollCentroid){let e=t-this._trackpadLastScrollCentroid.x,r=n-this._trackpadLastScrollCentroid.y;Math.abs(r)>2&&this._triggerMouseWheel(r<0?`down`:`up`,1),Math.abs(e)>2&&this._triggerHorizontalMouseWheel(e<0?`left`:`right`,1)}this._trackpadLastScrollCentroid={x:t,y:n}}}}else if(n===`touchend`||n===`touchcancel`){let e=this._trackpadTouches.size,n=!Array.from(this._trackpadTouches.values()).some(e=>e.moved);e===2&&n?(this.buttonMask|=4,this._sendPointer([`m2`,0,0,this.buttonMask,0],!1),setTimeout(()=>{this.buttonMask&=-5,this._sendPointer([`m2`,0,0,this.buttonMask,0],!1)},50),this._trackpadGestureMode=`completed`,this._trackpadLastTapTime=0):e===1&&n&&this._trackpadGestureMode!==`completed`&&this._trackpadGestureMode!==`dragging`&&(this._trackpadLastTapTime=t,this._trackpadTapTimeout=setTimeout(()=>{this.buttonMask|=1,this._sendPointer([`m2`,0,0,this.buttonMask,0],!1),setTimeout(()=>{this.buttonMask&=-2,this._sendPointer([`m2`,0,0,this.buttonMask,0],!1)},50)},200));for(let e of r)this._trackpadTouches.delete(e.identifier);this._trackpadTouches.size===0&&(this._trackpadGestureMode===`dragging`&&(this.buttonMask&=-2,this._sendPointer([`m2`,0,0,this.buttonMask,0],!1)),this._trackpadGestureMode=null,this._trackpadLastScrollCentroid=null)}}_sinkBox(e,t){let n=(window.manual_resolution||this.isSharedMode||window.streamResolutionDiverged)&&e?e:(window.manualResolution||window.streamResolutionDiverged)&&t?t:null;if(!n)return null;let r=n.getBoundingClientRect();if(!(r.width>0&&r.height>0)){this._sinkMirrors||={};for(let e of[`videoStream`,`videoWorkerCanvas`]){let t=this._sinkMirrors[e];if((!t||!t.isConnected)&&(t=document.getElementById(e),this._sinkMirrors[e]=t),!t)continue;let n=t.getBoundingClientRect();if(n.width>0&&n.height>0){r=n;break}}}!(r.width>0&&r.height>0)&&this._lastSinkRect&&(r=this._lastSinkRect);let i=n.videoWidth||n.width,a=n.videoHeight||n.height;if(r.width>0&&r.height>0&&i>0&&a>0){this._lastSinkRect=r;let e=r.left,t=r.top,o=r.width,s=r.height;if(n.tagName===`VIDEO`&&(n.style.objectFit||`contain`)!==`fill`){let n=Math.min(r.width/i,r.height/a);o=i*n,s=a*n,e+=(r.width-o)/2,t+=(r.height-s)/2}return{boxLeft:e,boxTop:t,boxW:o,boxH:s,sinkW:i,sinkH:a}}return null}_noteScreenAnchor(e){let t=e.screenX,n=e.screenY;if(!Number.isFinite(t)||!Number.isFinite(n)||Math.abs(e.clientX-this._sampleClientX)+Math.abs(e.clientY-this._sampleClientY)<8)return;let r=t-e.clientX,i=n-e.clientY,a=r===this._sampleAnchorX&&i===this._sampleAnchorY;this._sampleClientX=e.clientX,this._sampleClientY=e.clientY,this._sampleAnchorX=r,this._sampleAnchorY=i,!(!a||r===this._anchorX&&i===this._anchorY)&&(this._anchorX=r,this._anchorY=i,this._chromeInsetX=r-(window.screenX||0),this._chromeInsetY=i-(window.screenY||0),this._publishScreenGeometry())}_streamBox(){let e=this._sinkBox(document.getElementById(`videoCanvas`),document.getElementById(`stream`));if(e)return{left:e.boxLeft,top:e.boxTop,scaleX:e.sinkW/e.boxW,scaleY:e.sinkH/e.boxH};if(this.m||this._windowMath(),!this.m)return null;let t=this._inputDpr();return{left:this.m.elementClientX+this.m.mouseOffsetX,top:this.m.elementClientY+this.m.mouseOffsetY,scaleX:this.m.mouseMultiX*t,scaleY:this.m.mouseMultiY*t}}_screenStreamBox(){if(this._chromeInsetX==null)return null;let e=this._streamBox();return!e||!(e.scaleX>0)||!(e.scaleY>0)?null:{originX:(window.screenX||0)+this._chromeInsetX+e.left,originY:(window.screenY||0)+this._chromeInsetY+e.top,scaleX:e.scaleX,scaleY:e.scaleY}}_publishScreenGeometry(){if(!this._layout||this.isSharedMode)return;let e=this._screenStreamBox();if(!e)return;let t=this._layout.own;Math.abs(t.originX-e.originX)<1&&Math.abs(t.originY-e.originY)<1&&Math.abs(t.scaleX-e.scaleX)<.001&&Math.abs(t.scaleY-e.scaleY)<.001||this.send(`vp,${e.originX.toFixed(2)},${e.originY.toFixed(2)},${e.scaleX.toFixed(4)},${e.scaleY.toFixed(4)}`)}_watchScreenGeometry(e){e&&!this._geometryTimer?(this._geometryTimer=setInterval(()=>this._publishScreenGeometry(),1e3),this._publishScreenGeometry()):!e&&this._geometryTimer&&(clearInterval(this._geometryTimer),this._geometryTimer=null)}_applySinkCoordinates(e,t,n,r,i,a){let o=this._sinkBox(n,r);if(!o)return!1;let s=o.sinkW/o.boxW,c=o.sinkH/o.boxH,l=(e-o.boxLeft)*s,u=(t-o.boxTop)*c;return this._mapToLayout(l,u,s,c,i,a)?!0:(this.x=Math.max(0,Math.min(o.sinkW,Math.round(l))),this.y=Math.max(0,Math.min(o.sinkH,Math.round(u))),!0)}setDisplayLayouts(e,t){if(this._layout=null,!e||typeof e!=`object`){this._watchScreenGeometry(!1);return}let n=[],r=null;for(let i in e){let a=e[i];if(!a)continue;let o=Number(a.x),s=Number(a.y),c=Number(a.w),l=Number(a.h);if(!Number.isFinite(o)||!Number.isFinite(s)||!(c>0)||!(l>0))continue;let u=Number(a.scale),d={x:o,y:s,w:c,h:l,scale:Number.isFinite(u)&&u>0?u:0,originX:0,originY:0,scaleX:0,scaleY:0},f=Number(a.originX),p=Number(a.originY),m=Number(a.scaleX),h=Number(a.scaleY);Number.isFinite(f)&&Number.isFinite(p)&&m>0&&h>0&&(d.originX=f,d.originY=p,d.scaleX=m,d.scaleY=h),n.push(d),i===t&&(r=d)}if(!r||n.length<2){this._watchScreenGeometry(!1);return}for(let e=0;e<n.length;e++){let t=n[e];t.crossable=t!==r&&!this._boxesOverlap(r,t)}this._layout={own:r,rects:n,ownX:r.x,ownY:r.y,ownW:r.w,ownH:r.h},this._watchScreenGeometry(!0)}_boxesOverlap(e,t){return!(e.scaleX>0)||!(e.scaleY>0)||!(t.scaleX>0)||!(t.scaleY>0)?!1:e.originX+1<t.originX+t.w/t.scaleX&&t.originX+1<e.originX+e.w/e.scaleX&&e.originY+1<t.originY+t.h/t.scaleY&&t.originY+1<e.originY+e.h/e.scaleY}_overNeighbor(e,t,n){return!e.crossable||!(e.scaleX>0)||!(e.scaleY>0)||!Number.isFinite(t)||!Number.isFinite(n)?!1:t>=e.originX&&t<=e.originX+e.w/e.scaleX&&n>=e.originY&&n<=e.originY+e.h/e.scaleY}_mapToLayout(e,t,n,r,i,a){let o=this._layout;if(!o||e>=0&&e<=o.ownW&&t>=0&&t<=o.ownH)return!1;let s=o.ownX+e,c=o.ownY+t,l=null,u=1/0;for(let e=0;e<o.rects.length;e++){let t=o.rects[e];if(t===o.own)continue;let n=s<t.x?t.x-s:s>t.x+t.w?s-(t.x+t.w):0,r=c<t.y?t.y-c:c>t.y+t.h?c-(t.y+t.h):0,i=n*n+r*r;i<u&&(u=i,l=t)}if(l&&this._overNeighbor(l,i,a))s=l.x+(i-l.originX)*l.scaleX,c=l.y+(a-l.originY)*l.scaleY;else if(l&&l.scale>0&&n>0&&r>0){let i=l.scale/n,a=l.scale/r;e>o.ownW?s=o.ownX+o.ownW+(e-o.ownW)*i:e<0&&(s=o.ownX+e*i),t>o.ownH?c=o.ownY+o.ownH+(t-o.ownH)*a:t<0&&(c=o.ownY+t*a)}let d=s,f=c;u=1/0;for(let e=0;e<o.rects.length;e++){let t=o.rects[e],n=t.x+t.w-1,r=t.y+t.h-1,i=s<t.x?t.x:s>n?n:s,a=c<t.y?t.y:c>r?r:c,l=s-i,p=c-a,m=l*l+p*p;m<u&&(u=m,d=i,f=a)}return this.x=Math.round(d-o.ownX),this.y=Math.round(f-o.ownY),!0}_inputDpr(){return window.manual_resolution||window.manualResolution||this.isSharedMode?1:this._cursorDensity()}_cursorDensity(){return this._streamDensity?this._streamDensity:this.useCssScaling?1:window.devicePixelRatio||1}setStreamDensity(e){let t=Number.isFinite(e)&&e>0?e:null;this._streamDensity!==t&&(this._streamDensity=t,this._windowMath(),this._drawAndScaleCursor(),this._updateBrowserCursor())}_pointerScale(){if(this._pointerScaleFrame)return this._pointerScaleFrame;let e=this._streamBox(),t=e?{x:e.scaleX,y:e.scaleY}:{x:this._inputDpr(),y:this._inputDpr()};return typeof window.requestAnimationFrame==`function`&&(this._pointerScaleFrame=t,window.requestAnimationFrame(()=>{this._pointerScaleFrame=null})),t}_quantizeRelative(e,t){if(this._relCarryX+=e,this._relCarryY+=t,!Number.isFinite(this._relCarryX)||!Number.isFinite(this._relCarryY))return this._relCarryX=0,this._relCarryY=0,[0,0];let n=Math.round(this._relCarryX),r=Math.round(this._relCarryY);return this._relCarryX-=n,this._relCarryY-=r,[n,r]}_relativeToServer(e,t){let n=this._pointerScale();return this._quantizeRelative(e*n.x,t*n.y)}_calculateTouchCoordinates(e){this._noteScreenAnchor(e),this._updateCursorPosition(e.clientX,e.clientY),this._latestMouseX=e.clientX,this._latestMouseY=e.clientY;let t=this._inputDpr(),n=document.getElementById(`videoCanvas`),r=document.getElementById(`stream`);if(!this._applySinkCoordinates(e.clientX,e.clientY,n,r,e.screenX,e.screenY)){if(this.m||this._windowMath(),this.m){let n=this._clientToServerX(e.clientX)*t,r=this._clientToServerY(e.clientY)*t;this._mapToLayout(n,r,this.m.mouseMultiX*t,this.m.mouseMultiY*t,e.screenX,e.screenY)||(this.x=Math.round(n),this.y=Math.round(r))}else this.x=Math.round(e.clientX*t),this.y=Math.round(e.clientY*t)}}_sendMouseState(){if(this._flushCoalescedMouseMove(),this._isStreamLocked()){this._sendPointer([`m2`,0,0,this.buttonMask,0],!1);return}this._sendPointer([`m`,this.x,this.y,this.buttonMask,0],!1)}setTrackpadMode(e){let t=!!e;this._trackpadMode!==t&&(console.log(`Input: Trackpad mode ${t?`enabled`:`disabled`}.`),this._trackpadMode=t,this._activeTouches.clear(),this._activeTouchIdentifier=null,this._isTwoFingerGesture=!1,this._touchScrollLastCentroid=null,this._longPressTimer&&(clearTimeout(this._longPressTimer),this._longPressTimer=null,this._longPressTouchIdentifier=null),this.buttonMask!==0&&(this.buttonMask=0,this._sendMouseState()),this._trackpadMode||this.use_browser_cursors?(this.element.style.setProperty(`cursor`,`none`,`important`),this.element.style.cursor=`default`):(this.element.style.setProperty(`cursor`,`none`,`important`),this.cursorDiv.style.display=`none`))}setRawPointerMotion(t){let n=!!t;if(e.rawPointerMotion===n||(e.rawPointerMotion=n,console.log(`Input: Raw pointer motion ${n?`enabled`:`disabled`}.`),typeof document>`u`||!this._isStreamLocked()))return;let r=document.pointerLockElement;this._requestPointerLock(r,()=>{document.pointerLockElement===r&&this._requestPointerLock(r,()=>{},()=>{})},e=>{console.warn(`Input: pointer lock did not take the raw motion change:`,e)})}setShortcutsEnabled(e){this.shortcutsEnabled=!!e}setMacCmdAsCtrl(t){let n=!!t;e.macCmdAsCtrl!==n&&(e.macCmdAsCtrl=n,console.log(`Input: macOS Command sent as ${n?`Control`:`Super`}.`),this._macCmdSwapped&&=(`ControlLeft`in this._keyDownList&&this._sendKeyEvent(this._keyDownList.ControlLeft,`ControlLeft`,!1),!1))}async setUseBrowserCursors(e){let t=!!e;this.use_browser_cursors!==t&&(console.log(`Input: Use browser cursors ${t?`enabled`:`disabled`}.`),this.use_browser_cursors=t,this._trackpadMode?(this.cursorDiv.style.display=`none`,this.element.style.setProperty(`cursor`,`none`,`important`)):this.use_browser_cursors?(this.cursorDiv.style.display=`none`,this._updateBrowserCursor()):(this.element.style.setProperty(`cursor`,`none`,`important`),this._cursorBase64Data&&!this._cursorImageBitmap&&(this._cursorImageBitmap=await this._cursorBitmapFromBase64(this._cursorBase64Data)),this._cursorImageBitmap?(this.cursorDiv.style.display=`block`,this._drawAndScaleCursor()):this.cursorDiv.style.display=`none`))}_handleTouchEvent(e){if(this._trackpadMode){this._handleTrackpadEvent(e);return}if(this._targetHasClass(e.target,we)||!this._guac_markEvent(e))return;let t=e.type,n=Date.now(),r=!1,i=!1,a=this._TAP_THRESHOLD_DISTANCE_SQ;if(t===`touchstart`){this.use_browser_cursors||(this.cursorDiv.style.display=`block`);for(let t=0;t<e.changedTouches.length;t++){let r=e.changedTouches[t];this._activeTouches.has(r.identifier)||(this._activeTouches.set(r.identifier,{startX:r.clientX,startY:r.clientY,currentX:r.clientX,currentY:r.clientY,startTime:n,identifier:r.identifier,longPressCompleted:!1}),t===0&&this._calculateTouchCoordinates(r))}let t=this._activeTouches.size;if(t===1&&!this._isTwoFingerGesture){r=!0;let[e]=this._activeTouches.keys(),t=this._activeTouches.get(e),n={clientX:t.currentX,clientY:t.currentY};this._calculateTouchCoordinates(n);let i=this.x,a=this.y;t&&!t.longPressCompleted&&(this._longPressTouchIdentifier=e,this._longPressTimer&&clearTimeout(this._longPressTimer),this._longPressTimer=setTimeout(()=>{let e=this._activeTouches.get(this._longPressTouchIdentifier);if(e&&this._activeTouches.size===1&&this._longPressTouchIdentifier===e.identifier&&!this._isTwoFingerGesture&&this._activeTouchIdentifier===null&&!e.longPressCompleted){let t=e.currentX-e.startX,n=e.currentY-e.startY;t*t+n*n<225&&(e.longPressCompleted=!0,this.x=i,this.y=a,this.buttonMask|=4,this._sendMouseState(),setTimeout(()=>{this.buttonMask&4&&(this.buttonMask&=-5,this._sendMouseState())},50))}this._longPressTimer=null},750))}else{if(this._longPressTimer&&=(clearTimeout(this._longPressTimer),null),t===2){this.use_browser_cursors||(this.cursorDiv.style.visibility=`hidden`),this._isTwoFingerGesture=!0,this._activeTouchIdentifier=null;let e=Array.from(this._activeTouches.values());this._touchScrollLastCentroid={x:(e[0].currentX+e[1].currentX)/2,y:(e[0].currentY+e[1].currentY)/2},(this.buttonMask&1)==1&&(this.buttonMask&=-2),r=!0}else t>2&&(this._isTwoFingerGesture&&=!1,this._activeTouchIdentifier!==null&&(this.buttonMask&=-2,this._sendMouseState(),this._activeTouchIdentifier=null));t!==1&&(this._longPressTouchIdentifier=null)}}else if(t===`touchmove`)for(let t=0;t<e.changedTouches.length;t++){let n=e.changedTouches[t],r=this._activeTouches.get(n.identifier);if(r&&(r.currentX=n.clientX,r.currentY=n.clientY,this._longPressTimer&&n.identifier===this._longPressTouchIdentifier)){let e=r.currentX-r.startX,t=r.currentY-r.startY;e*e+t*t>=225&&(clearTimeout(this._longPressTimer),this._longPressTimer=null)}}if(this._isTwoFingerGesture&&this._activeTouches.size===2){r=!0;let e=Array.from(this._activeTouches.values()),t=(e[0].currentX+e[1].currentX)/2,n=(e[0].currentY+e[1].currentY)/2;if(this._touchScrollLastCentroid){let e=t-this._touchScrollLastCentroid.x,r=n-this._touchScrollLastCentroid.y;Math.abs(r)>2&&this._triggerMouseWheel(r<0?`down`:`up`,1),Math.abs(e)>2&&this._triggerHorizontalMouseWheel(e<0?`left`:`right`,1)}this._touchScrollLastCentroid={x:t,y:n}}else if(this._activeTouches.size===1){let[e]=this._activeTouches.keys(),t=this._activeTouches.get(e);if(this._activeTouchIdentifier===e)this._calculateTouchCoordinates({clientX:t.currentX,clientY:t.currentY}),this._sendMouseState(),i=!0,r=!0;else if(this._activeTouchIdentifier===null&&!t.longPressCompleted){let n=t.currentX-t.startX,o=t.currentY-t.startY;n*n+o*o>=a?(this._longPressTimer&&e===this._longPressTouchIdentifier&&(clearTimeout(this._longPressTimer),this._longPressTimer=null),this._activeTouchIdentifier=e,this._calculateTouchCoordinates({clientX:t.currentX,clientY:t.currentY}),this.buttonMask|=1,this._sendMouseState(),i=!0,r=!0):r=!0}}if(this._activeTouchIdentifier!==null&&!i&&this._activeTouches.size>0)r=!0;else if(t===`touchend`||t===`touchcancel`){let t=e.changedTouches;for(let e=0;e<t.length;e++){let i=t[e],o=i.identifier,s=this._activeTouches.get(o);if(!s)continue;if(this._longPressTimer&&o===this._longPressTouchIdentifier&&(clearTimeout(this._longPressTimer),this._longPressTimer=null),s.longPressCompleted){this._activeTouches.delete(o),o===this._longPressTouchIdentifier&&(this._longPressTouchIdentifier=null),r=!0;continue}s.currentX=i.clientX,s.currentY=i.clientY;let c=n-s.startTime,l=s.currentX-s.startX,u=s.currentY-s.startY,d=l*l+u*u;this._isTwoFingerGesture||(this._activeTouchIdentifier===null&&this._activeTouches.size===1&&this._activeTouches.has(o)?c<this._TAP_MAX_DURATION&&d<a&&(this._calculateTouchCoordinates(i),this.buttonMask|=1,this._sendMouseState(),r=!0,setTimeout(()=>{this.buttonMask&=-2,this._sendMouseState()},10)):o===this._activeTouchIdentifier&&(this._calculateTouchCoordinates(i),this.buttonMask&=-2,this._sendMouseState(),this._activeTouchIdentifier=null,r=!0)),this._activeTouches.delete(o),o===this._longPressTouchIdentifier&&(this._longPressTouchIdentifier=null)}{let e=this._activeTouches.size;if(this._isTwoFingerGesture&&e<2&&(!this._trackpadMode&&!this.use_browser_cursors&&(this.cursorDiv.style.visibility=`visible`),this._isTwoFingerGesture=!1,this._touchScrollLastCentroid=null),e===0&&(this._activeTouchIdentifier=null,this._isTwoFingerGesture=!1,this._touchScrollLastCentroid=null,this._longPressTimer&&=(clearTimeout(this._longPressTimer),null),this._longPressTouchIdentifier=null),e>0&&this._longPressTouchIdentifier&&!this._activeTouches.has(this._longPressTouchIdentifier)&&(this._longPressTimer&&clearTimeout(this._longPressTimer),this._longPressTimer=null,this._longPressTouchIdentifier=null),e===1){let[e]=this._activeTouches.keys();if(this._longPressTouchIdentifier!==e){this._longPressTimer&&clearTimeout(this._longPressTimer),this._longPressTimer=null,this._longPressTouchIdentifier=null;let t=this._activeTouches.get(e);if(t&&!t.longPressCompleted){let n={clientX:t.currentX,clientY:t.currentY,identifier:e};this._calculateTouchCoordinates(n);let r=this.x,i=this.y;this._longPressTouchIdentifier=e,this._longPressTimer=setTimeout(()=>{let e=this._activeTouches.get(this._longPressTouchIdentifier);if(e&&this._activeTouches.size===1&&this._longPressTouchIdentifier===e.identifier&&!this._isTwoFingerGesture&&this._activeTouchIdentifier===null&&!e.longPressCompleted){let t=e.currentX-e.startX,n=e.currentY-e.startY;t*t+n*n<225&&(e.longPressCompleted=!0,this.x=r,this.y=i,this.buttonMask|=4,this._sendMouseState(),setTimeout(()=>{this.buttonMask&4&&(this.buttonMask&=-5,this._sendMouseState())},50))}this._longPressTimer=null},750)}}}else e!==1&&(this._longPressTimer&&clearTimeout(this._longPressTimer),this._longPressTimer=null,this._longPressTouchIdentifier=null)}}r&&this.element.contains(e.target)&&e.preventDefault()}_triggerMouseWheel(e,t){t=Math.max(1,Math.round(t));let n=1<<(e===`up`?4:3),r=this.buttonMask&~n;this._sendPointer([`m2`,0,0,r,t],!1),this._sendPointer([`m2`,0,0,r|n,t],!1),this._sendPointer([`m2`,0,0,this.buttonMask,t],!1)}_triggerHorizontalMouseWheel(e,t){t=Math.max(1,Math.round(t));let n=1<<(e===`left`?6:7);this._sendPointer([`m2`,0,0,this.buttonMask|n,t],!1),this._sendPointer([`m2`,0,0,this.buttonMask,t],!1)}_isDiscreteWheel(){for(var e=[];!this._queue.isEmpty();){var t=this._queue.dequeue();t>0&&e.push(t)}if(e.length<2)return!0;var n=Math.min.apply(null,e);if(n<80)return!1;for(var r=0;r<e.length;r++){var i=e[r]/n;if(Math.abs(i-Math.round(i))>.15)return!1}return!0}_resetWheelLearning(){for(this._smallestDeltaY=1e4,this._smallestLineDeltaY=1e4,this._allowThreshold=!0;!this._queue.isEmpty();)this._queue.dequeue();this._wheelAccumY=0,this._wheelDirY=null,this._wheelAccumX=0,this._wheelDirX=null}_mouseWheelWrapper(e){let t=performance.now();if(t-this._lastWheelEventTs>1e3&&this._resetWheelLearning(),this._lastWheelEventTs=t,e.deltaMode!==0){this._mouseWheel(e),e.preventDefault();return}var n=Math.trunc(Math.abs(e.deltaY));n!==0&&this._queue.size()<4&&this._queue.enqueue(n),this._queue.size()==4&&(this._allowThreshold=!this._isDiscreteWheel()),this._allowThreshold?this._allowTrackpadScrolling?(this._allowTrackpadScrolling=!1,this._mouseWheel(e),setTimeout(()=>{this._allowTrackpadScrolling=!0,this._emitWheelY(),this._emitWheelX()},this._wheelThreshold)):(this._accumulateWheelY(e),this._accumulateWheelX(e)):this._mouseWheel(e),e.preventDefault()}_wheelNotches(e,t){let n=Math.abs(Math.trunc(e));return n===0?0:t===1?(n<this._smallestLineDeltaY&&(this._smallestLineDeltaY=n),n/this._smallestLineDeltaY):t===2?Math.max(1,n):(n<this._smallestDeltaY&&(this._smallestDeltaY=n),this._allowThreshold?n/100:n/this._smallestDeltaY)}_wheelNotchesX(e,t){let n=Math.abs(e);return n===0?0:t===0?n/100:n}_accumulateWheelY(e){if(e.deltaY===0)return;let t=e.deltaY<0?`up`:`down`;t!==this._wheelDirY&&(this._wheelAccumY=0,this._wheelDirY=t),this._wheelAccumY+=this._wheelNotches(e.deltaY,e.deltaMode)}_accumulateWheelX(e){if(e.deltaX===0)return;let t=e.deltaX<0?`left`:`right`;t!==this._wheelDirX&&(this._wheelAccumX=0,this._wheelDirX=t),this._wheelAccumX+=this._wheelNotchesX(e.deltaX,e.deltaMode)}_emitWheelY(){let e=Math.floor(this._wheelAccumY);if(!(e<1))for(this._wheelAccumY-=e;e>0;){let t=Math.min(e,this._scrollMagnitude);this._triggerMouseWheel(this._wheelDirY,t),e-=t}}_emitWheelX(){let e=Math.floor(this._wheelAccumX);if(!(e<1))for(this._wheelAccumX-=e;e>0;){let t=Math.min(e,this._scrollMagnitude);this._triggerHorizontalMouseWheel(this._wheelDirX,t),e-=t}}_mouseWheel(e){this._accumulateWheelY(e),this._emitWheelY(),this._accumulateWheelX(e),this._emitWheelX()}_contextMenu(e){this.element.contains(e.target)&&e.preventDefault()}_streamLockTargets(){let e=[`videoCanvas`,`videoWorkerCanvas`,`videoStream`,`stream`].map(e=>document.getElementById(e));return e.push(this.element),e.filter(e=>e!=null)}_isStreamLocked(){let e=document.pointerLockElement;return e==null?!1:e===this.element||this._streamLockTargets().includes(e)}_pointerLock(){this._relCarryX=0,this._relCarryY=0,this._isStreamLocked()?(this.send(`p,1`),this.send(`SET_NATIVE_CURSOR_RENDERING,1`),this.cursorDiv.style.visibility=`hidden`):(this.send(`p,0`),this.send(`SET_NATIVE_CURSOR_RENDERING,0`),this.resetKeyboard(),this.cursorDiv.style.visibility=`visible`)}_windowMath(){this._pointerScaleFrame=null;let e=this.element.getBoundingClientRect(),t=e.width,n=e.height,r=this.element.offsetWidth,i=this.element.offsetHeight;if(t<=0||n<=0||r<=0||i<=0){this.m=null;return}let a=t/r,o=n/i,s=Math.min(a,o),c=r*s,l=i*s,u=(t-c)/2,d=(n-l)/2,f=c>0?r/c:1,p=l>0?i/l:1;this.m={mouseMultiX:f,mouseMultiY:p,mouseOffsetX:u,mouseOffsetY:d,elementClientX:e.left,elementClientY:e.top,frameW:r,frameH:i}}_clientToServerX(e){return this.m?(e-this.m.elementClientX-this.m.mouseOffsetX)*this.m.mouseMultiX:0}_clientToServerY(e){return this.m?(e-this.m.elementClientY-this.m.mouseOffsetY)*this.m.mouseMultiY:0}_encodeGamepadId(e){let t=String(e||`Gamepad`).replace(/[^\x00-\xFF]/g,`?`);try{return btoa(t)}catch{return btoa(`Gamepad`)}}_gamepadConnected(e){let t=this.controllerSlot===null?this.playerIndex:this.controllerSlot-1;if(!Number.isInteger(t)||t<0)return;this.gamepadManager||=new D(e.gamepad,this._gamepadButton.bind(this),this._gamepadAxis.bind(this),this._gamepadHeartbeat.bind(this));let n=`js,c,`+t+`,`+this._encodeGamepadId(e.gamepad.id)+`,`+e.gamepad.axes.length+`,`+e.gamepad.buttons.length;this.send(n),this.ongamepadconnected!==null&&this.ongamepadconnected(e.gamepad.id)}_gamepadDisconnect(e){this.ongamepaddisconnected!==null&&this.ongamepaddisconnected();let t=this.controllerSlot===null?this.playerIndex:this.controllerSlot-1;!Number.isInteger(t)||t<0||this.send(`js,d,`+t)}_gamepadButton(e,t,n){let r=this.controllerSlot===null?this.playerIndex:this.controllerSlot-1;!Number.isInteger(r)||r<0||(this.send(`js,b,`+r+`,`+t+`,`+n),this._isSidebarOpen&&window.postMessage({type:`gamepadButtonUpdate`,gamepadIndex:r,buttonIndex:t,value:n},window.location.origin))}_gamepadHeartbeat(){let e=this.controllerSlot===null?this.playerIndex:this.controllerSlot-1;!Number.isInteger(e)||e<0||this.send(`js,h,`+e)}_gamepadAxis(e,t,n){let r=this.controllerSlot===null?this.playerIndex:this.controllerSlot-1;if(!(!Number.isInteger(r)||r<0)){if(navigator.userAgent.toLowerCase().includes(`firefox`)){if(t===4){let e=(n+1)/2;this.send(`js,b,`+r+`,6,`+e);return}if(t===5){let e=(n+1)/2;this.send(`js,b,`+r+`,7,`+e);return}}this.send(`js,a,`+r+`,`+t+`,`+n),this._isSidebarOpen&&window.postMessage({type:`gamepadAxisUpdate`,gamepadIndex:r,axisIndex:t,value:n},window.location.origin)}}_isStreamFullscreen(){let e=document.fullscreenElement;return e!==null&&e.contains(this.element)}_requestPointerLock(t,n,r){let i=e._asksRawMotion(),a=i?t.requestPointerLock({unadjustedMovement:!0}):t.requestPointerLock();a&&typeof a.catch==`function`&&a.catch(t=>{if(t&&t.name===`NotSupportedError`&&i){e._rawMotionRefused=!0,n();return}r(t)})}_armPointerLock(e=0){this.inputAttached&&this.gamingMode&&this._isStreamFullscreen()&&(this._isStreamLocked()||this._requestPointerLock(this.element,()=>this._armPointerLock(e),t=>{e<5?setTimeout(()=>this._armPointerLock(e+1),60):console.warn(`Pointer lock failed on fullscreen:`,t)}))}_onFullscreenChange(){this._isStreamFullscreen()?this.inputAttached&&this.gamingMode&&(this._armPointerLock(),this.requestKeyboardLock()):(this._setGamingMode(!1),this._isStreamLocked()&&document.exitPointerLock()),this.send(`kr`),this.resetKeyboard()}_targetHasClass(e,t){let n=e;for(;n&&n.classList;){if(n.classList.contains(t))return!0;n=n.parentElement}return!1}getWindowResolution(){let e=document.body?document.body.offsetWidth:window.innerWidth,t=document.body?document.body.offsetHeight:window.innerHeight,n=window.devicePixelRatio||1,r=e*n,i=t*n;return[Math.max(1,parseInt(r-r%2)),Math.max(1,parseInt(i-i%2))]}resize(){this._windowMath()}isInputAttached(){return this.inputAttached}attach(){if(e._attachedInstance&&e._attachedInstance!==this)try{e._attachedInstance.detach()}catch{}if(e._attachedInstance=this,this._focusCompositionHost(),this.listeners.push(I(this.element,`resize`,this._windowMath,this)),this.listeners.push(I(document,`pointerlockchange`,this._pointerLock,this)),this.listeners.push(I(document,`fullscreenchange`,this._onFullscreenChange,this)),this.listeners.push(I(window,`resize`,this._windowMath,this)),this.listeners.push(I(window,`gamepadconnected`,this._gamepadConnected,this)),this.listeners.push(I(window,`gamepaddisconnected`,this._gamepadDisconnect,this)),this.listeners.push(I(window,`message`,this._handleVisibilityMessage,this)),this.listeners.push(I(window,`orientationchange`,()=>{setTimeout(()=>this._windowMath(),200),setTimeout(()=>this._windowMath(),500)},this)),!this.isSharedMode)this.attach_context();else{let e=e=>e.preventDefault();this.listeners.push(I(this.element,`touchstart`,e,this)),this.listeners.push(I(this.element,`touchend`,e,this)),this.listeners.push(I(this.element,`touchmove`,e,this)),this.listeners.push(I(this.element,`touchcancel`,e,this))}this.resyncGamepads()}attach_context(){if(this.inputAttached)return;this._windowMath(),this.element.style.setProperty(`cursor`,`none`,`important`),(this._cursorImageBitmap||this._cursorBase64Data)&&(this.use_browser_cursors?this._updateBrowserCursor():(this.cursorDiv.style.display=`block`,this._drawAndScaleCursor())),this.listeners_context.push(I(window,`keydown`,this._handleKeyDown,this,!0)),this.listeners_context.push(I(window,`keyup`,this._handleKeyUp,this,!0)),this.listeners_context.push(I(window,`blur`,this.resetKeyboard,this)),this.listeners_context.push(I(document,`visibilitychange`,this._onVisibilityChange,this)),this.listeners_context.push(I(window,`pagehide`,this.resetKeyboard,this)),this.listeners_context.push(I(document,`freeze`,this.resetKeyboard,this)),this.listeners_context.push(I(this.keyboardInputAssist,`input`,this._handleMobileInput,this)),this.listeners_context.push(I(this.keyboardInputAssist,`compositionstart`,this._assistCompositionStart,this)),this.listeners_context.push(I(this.keyboardInputAssist,`compositionend`,this._assistCompositionEnd,this)),this.listeners_context.push(I(this.keyboardInputAssist,`focus`,this._assistFocusChange,this)),this.listeners_context.push(I(this.keyboardInputAssist,`blur`,this._assistFocusChange,this)),this.listeners_context.push(I(document,`mousedown`,this._handleOutsideClick,this,!0)),this.listeners_context.push(I(document,`touchstart`,this._handleOutsideClick,this,!0)),this.listeners_context.push(I(this.element,`wheel`,this._mouseWheelWrapper,this)),this.listeners_context.push(I(this.element,`contextmenu`,this._contextMenu,this));let e=this.element;this.listeners_context.push(I(e,`compositionstart`,this._compositionStart,this)),this.listeners_context.push(I(e,`compositionupdate`,this._compositionUpdate,this)),this.listeners_context.push(I(e,`compositionend`,this._compositionEnd,this)),this.listeners_context.push(I(this.element,`textInput`,this._handleTextInput,this)),this.listeners_context.push(I(this.element,`pointerdown`,this._handlePointerDown,this)),this.listeners_context.push(I(this.element,`pointermove`,this._handlePointerMove,this)),this.listeners_context.push(I(this.element,`pointerup`,this._handlePointerUp,this)),this.listeners_context.push(I(this.element,`pointercancel`,this._handlePointerUp,this)),`ontouchstart`in window&&(this.listeners_context.push(I(this.element,`touchstart`,this._handleTouchEvent,this,!1)),this.listeners_context.push(I(this.element,`touchend`,this._handleTouchEvent,this,!1)),this.listeners_context.push(I(this.element,`touchmove`,this._handleTouchEvent,this,!1)),this.listeners_context.push(I(this.element,`touchcancel`,this._handleTouchEvent,this,!1))),this.listeners_context.push(I(this.element,`mousedown`,this._mouseButtonMovement,this)),this.listeners_context.push(I(window,`mousemove`,this._mouseButtonMovement,this)),this.listeners_context.push(I(window,`mouseup`,this._mouseButtonMovement,this)),this.inputAttached=!0,this._isStreamFullscreen()&&this.gamingMode?(this._armPointerLock(),this.requestKeyboardLock()):this._isStreamLocked()&&this._pointerLock(),this._windowMath()}resyncGamepads(){let e=[];try{e=navigator.getGamepads?Array.from(navigator.getGamepads()):[]}catch{return}for(let t of e)if(t&&t.connected){this._gamepadConnected({gamepad:t});break}}detach(){e._attachedInstance===this&&(e._attachedInstance=null),ze(this.listeners),this.listeners=[],this.gamepadManager&&=(this.gamepadManager.destroy(),null),this._watchScreenGeometry(!1),this.detach_context()}detach_context(){this._stopKeyHeartbeat(),ze(this.listeners_context),this.listeners_context=[],this.element.style.cursor=`auto`,this.cursorDiv.style.display=`none`,this.send(`kr`),this.resetKeyboard(),this._activeTouches.clear(),this._activeTouchIdentifier=null,this._isTwoFingerGesture=!1,this._pendingMove=null,this._relCarryX=0,this._relCarryY=0,(this.buttonMask&1)==1&&(this.buttonMask&=-2,this._sendMouseState()),this.inputAttached=!1,this._exitPointerLock()}_exitPointerLock(){this._isStreamLocked()&&(document.exitPointerLock(),this.send(`p,0`),console.log(`remote pointer visibility to: False`))}enterFullscreen(){document.fullscreenElement===null&&document.documentElement.requestFullscreen().catch(e=>console.error(`Fullscreen request failed:`,e))}toggleGamingMode(){if(!this.gamingMode){this.enterGamingMode();return}document.fullscreenElement===null?this._setGamingMode(!1):document.exitFullscreen().catch(e=>console.error(`Fullscreen exit failed:`,e))}enterGamingMode(){if(this._setGamingMode(!0),document.fullscreenElement===null){document.documentElement.requestFullscreen().catch(e=>{console.error(`Fullscreen request failed:`,e),this._setGamingMode(!1)});return}this._armPointerLock(),this.requestKeyboardLock()}_setGamingMode(e){this.gamingMode!==e&&(this.gamingMode=e,e||this.releaseKeyboardLock(),this.ongamingmode&&this.ongamingmode(e))}requestKeyboardLock(){if(this.gamingMode&&document.fullscreenElement){if(navigator.keyboard&&`lock`in navigator.keyboard){navigator.keyboard.lock([`AltLeft`,`AltRight`,`Tab`,`Escape`,`MetaLeft`,`MetaRight`,`ContextMenu`]).catch(()=>{});return}this._noticeKeyboardLockUnavailable()}}_noticeKeyboardLockUnavailable(){if(e._keyboardLockNoticed)return;e._keyboardLockNoticed=!0;let t=typeof navigator<`u`&&!!navigator.brave,n=t?`keyboardLockBlockedByShields`:`keyboardLockUnavailable`,r=t?`Brave's Shields block the keyboard lock, so a single Escape leaves gaming mode. Allow the keyboard API for this site under the Shields fingerprinting controls to hold Escape instead.`:`This browser offers no keyboard lock, so a single Escape leaves gaming mode instead of reaching the session.`;console.warn(`Input: `+r),this.onnotice&&this.onnotice(n,r)}releaseKeyboardLock(){if(navigator.keyboard&&`unlock`in navigator.keyboard)try{navigator.keyboard.unlock()}catch{}}};Ce(Re,`_nextGuacID`,0),Ce(Re,`rawPointerMotion`,!M.isMacDesktop()),Ce(Re,`macCmdAsCtrl`,!0),Ce(Re,`_rawMotionRefused`,!1),Ce(Re,`_keyboardLockNoticed`,!1),Ce(Re,`_cursorImageSetFn`,void 0);function I(e,t,n,r,i=!1){if(!e||typeof e.addEventListener!=`function`)return console.error(`addListener: Invalid target object`,e),null;let a=r?n.bind(r):n,o={capture:i,passive:!1};return e.addEventListener(t,a,o),[e,t,a,o]}function ze(e){for(let t of e)t&&t[0]&&typeof t[0].removeEventListener==`function`&&t[0].removeEventListener(t[1],t[2],t[3]);e.length=0}var Be=class{constructor(e,t,n){this.signaling=e,this.element=t,this.peer_id=n,this.forceTurn=!1,this.rtcPeerConfig={lifetimeDuration:`86400s`,iceServers:[{urls:[`stun:stun.l.google.com:19302`]}],blockStatus:`NOT_BLOCKED`,iceTransportPolicy:`all`},this.peerConnection=null,this._micTransceiver=null,this._micStream=null,this._webcamTransceiver=null,this._webcamStream=null,this.onstatus=null,this.ondebug=null,this.onerror=null,this.onconnectionstatechange=null,this.ondatachannelopen=null,this.ondatachannelclose=null,this.onstreaminfo=null,this.onlatencymeasurement=null,this.onplaystreamrequired=null,this.onclipboardcontent=null,this.onsystemaction=null,this.oncursorchange=null,this.cursor_cache=new Map,this.onstreamstats=null,this.signaling.onsdp=this._onSDP.bind(this),this.signaling.onice=this._onSignalingICE.bind(this),this._connected=!1,this._send_channel=null,this._motion_channel=null,this._gzTx=!1,this._sendQueue=Promise.resolve(),this._recvQueue=Promise.resolve(),this.input=null,this.clipboardcontent=[],this.onserversettings=null,this.ondisplayconfig=null,this.onprintdocument=null}_setStatus(e){this.onstatus!==null&&this.onstatus(e)}_setDebug(e){this.ondebug!==null&&this.ondebug(e)}_setError(e){this.onerror!==null&&this.onerror(e)}_setConnectionState(e){this.onconnectionstatechange!==null&&this.onconnectionstatechange(e)}_onSignalingICE(e){if(this._setDebug(`received ice candidate from signaling server: `+JSON.stringify(e)),this.forceTurn&&JSON.stringify(e).indexOf(`relay`)<0){this._setDebug(`Rejecting non-relay ICE candidate: `+JSON.stringify(e));return}this.peerConnection.addIceCandidate(e).catch(this._setError)}_onPeerICE(e){if(e.candidate===null){this._setStatus(`Completed ICE candidates from peer connection`);return}this.signaling.sendICE(e.candidate)}_onSDP(e){if(e.type!=`offer`){this._setError(`received SDP was not type offer.`);return}console.log(`Received remote SDP`,e),this.peerConnection.setRemoteDescription(e).then(()=>{this._setDebug(`received SDP offer, creating answer`),this._prepareUplinkTransceivers(e.sdp),this.peerConnection.createAnswer().then(t=>{if(!/[^-]sps-pps-idr-in-keyframe=1[^\d]/gm.test(t.sdp)&&/[^-]packetization-mode=/gm.test(t.sdp)&&(console.log(`Overriding WebRTC SDP to include sps-pps-idr-in-keyframe=1`),t.sdp=/[^-]sps-pps-idr-in-keyframe=\d+/gm.test(t.sdp)?t.sdp.replace(/sps-pps-idr-in-keyframe=\d+/gm,`sps-pps-idr-in-keyframe=1`):t.sdp.replace(`packetization-mode=`,`sps-pps-idr-in-keyframe=1;packetization-mode=`)),t.sdp.indexOf(`multiopus`)===-1){!/[^-]stereo=1[^\d]/gm.test(t.sdp)&&/[^-]useinbandfec=/gm.test(t.sdp)&&(console.log(`Overriding WebRTC SDP to allow stereo audio`),t.sdp=/[^-]stereo=\d+/gm.test(t.sdp)?t.sdp.replace(/stereo=\d+/gm,`stereo=1`):t.sdp.replace(`useinbandfec=`,`stereo=1;useinbandfec=`));let n=e.sdp.match(/^a=ptime:(\d+)/m),r=Math.max(3,Math.min(10,n?parseInt(n[1],10):10));!RegExp(`[^-]minptime=`+r+`[^\\d]`,`gm`).test(t.sdp)&&/[^-]useinbandfec=/gm.test(t.sdp)&&(console.log(`Overriding WebRTC SDP to allow low-latency audio packet (minptime=`+r+`)`),t.sdp=/[^-]minptime=\d+/gm.test(t.sdp)?t.sdp.replace(/minptime=\d+/gm,`minptime=`+r):t.sdp.replace(`useinbandfec=`,`minptime=`+r+`;useinbandfec=`))}console.log(`Created local SDP`,t),this.peerConnection.setLocalDescription(t).then(()=>{this._setDebug(`Sending SDP answer`),this.signaling.sendSDP(this.peerConnection.localDescription)}).catch(e=>{this._setError(`Error setting local description: `+e)})}).catch(()=>{this._setError(`Error creating local SDP`)})}).catch(e=>{this._setError(`Error setting remote description: `+e)})}_prepareUplinkTransceivers(e){if(this._micTransceiver=null,this._webcamTransceiver=null,!e||!this.peerConnection)return;let t={audio:null,video:null},n=null,r=null,i=!1,a=()=>{r&&i&&n!==null&&t[r]===null&&Object.prototype.hasOwnProperty.call(t,r)&&(t[r]=n)};for(let t of e.split(/\r?\n/))t.startsWith(`m=`)?(a(),r=t.slice(2).split(` `)[0],n=null,i=!1):t.startsWith(`a=mid:`)?n=t.slice(6).trim():t.trim()===`a=recvonly`&&(i=!0);a();let o=this.peerConnection.getTransceivers(),s=e=>{if(e===null)return null;let t=o.find(t=>t.mid===e);if(t)try{t.direction=`sendonly`}catch{}return t||null};this._micTransceiver=s(t.audio),this._webcamTransceiver=s(t.video)}async setMicrophone(e,t=null){if(e){if(!this._micTransceiver)throw Error(`Microphone is disabled on this server.`);if(this._micStream)return!0;if(!navigator.mediaDevices||!navigator.mediaDevices.getUserMedia)return!1;let e={channelCount:1,sampleRate:24e3,echoCancellation:!0,noiseSuppression:!0,autoGainControl:!0};t&&(e.deviceId={exact:t}),this._micStream=await navigator.mediaDevices.getUserMedia({audio:e,video:!1});let n=this._micStream.getAudioTracks()[0];return this._micTransceiver&&this._micTransceiver.sender&&n&&await this._micTransceiver.sender.replaceTrack(n),!0}if(this._micTransceiver&&this._micTransceiver.sender)try{await this._micTransceiver.sender.replaceTrack(null)}catch{}return this._micStream&&=(this._micStream.getTracks().forEach(e=>e.stop()),null),!0}async setWebcam(e,t=null,{width:n=1280,height:r=720,fps:i=30,codec:a=`auto`}={}){if(e){if(!this._webcamTransceiver)throw Error(`Webcam is disabled on this server.`);if(this._webcamStream)return!0;if(!navigator.mediaDevices||!navigator.mediaDevices.getUserMedia)return!1;let e={width:{ideal:n},height:{ideal:r},frameRate:{ideal:i}};t&&(e.deviceId={exact:t});let o=await navigator.mediaDevices.getUserMedia({video:e,audio:!1}),s=o.getVideoTracks()[0];try{s&&(await this._setSenderActive(this._webcamTransceiver.sender,!0),await this._webcamTransceiver.sender.replaceTrack(s))}catch(e){throw o.getTracks().forEach(e=>e.stop()),e}return this._webcamStream=o,await this.setWebcamCodec(a),!0}if(this._webcamTransceiver&&this._webcamTransceiver.sender){await this._setSenderActive(this._webcamTransceiver.sender,!1);try{await this._webcamTransceiver.sender.replaceTrack(null)}catch{}}return this._webcamStream&&=(this._webcamStream.getTracks().forEach(e=>e.stop()),null),!0}async setWebcamCodec(e){let t=this._webcamTransceiver&&this._webcamTransceiver.sender;if(!t||!t.track)return!1;let n=`video/${String(e||`auto`).toLowerCase()}`;try{let e=t.getParameters();if(!e.encodings||e.encodings.length===0)return!1;let r=(e.codecs||[]).find(e=>e.mimeType.toLowerCase()===n)||null,i=e.encodings[0].codec||null;if(r){if(i&&i.mimeType.toLowerCase()===n)return!0;e.encodings[0].codec={mimeType:r.mimeType,clockRate:r.clockRate,sdpFmtpLine:r.sdpFmtpLine}}else{if(!i)return!1;delete e.encodings[0].codec}return await t.setParameters(e),!!r}catch(e){return console.warn(`Webcam codec not applied to the sender:`,e),!1}}async _setSenderActive(e,t){try{let n=e.getParameters();if(!n.encodings||n.encodings.length===0)return;let r=!1;n.encodings.forEach(e=>{e.active!==t&&(e.active=t,r=!0)}),r&&await e.setParameters(n)}catch(e){console.warn(`Sender encoding activation not applied:`,e)}}get webcamTrack(){return this._webcamStream&&this._webcamStream.getVideoTracks()[0]||null}_onLocalSDP(e){this._setDebug(`Created local SDP: `+JSON.stringify(e))}_ontrack(e){this._setStatus(`Received incoming `+e.track.kind+` stream from peer`),this.streams||=[],this.streams.push([e.track.kind,e.streams]),e.track.kind===`video`&&(this.element.srcObject=e.streams[0],this.playStream())}_onPeerdDataChannel(e){if(this._setStatus(`Peer data channel created: `+e.channel.label),e.channel.label===`pointer`){this._motion_channel=e.channel;return}this._send_channel=e.channel,this._send_channel.binaryType=`arraybuffer`,this._send_channel.onmessage=this._onPeerDataChannelMessage.bind(this),this._send_channel.onopen=()=>{typeof CompressionStream<`u`&&this._send_channel.send(`_gz,1`),this.ondatachannelopen!==null&&this.ondatachannelopen()},this._send_channel.onclose=()=>{this.ondatachannelclose!==null&&this.ondatachannelclose()},this._send_channel.onerror=e=>{this._setError(`Unexpected error, data channel closed, ${e.error||`unknown error`}`)}}_onPeerDataChannelMessage(e){if(e.data instanceof ArrayBuffer){let t=new Uint8Array(e.data,0,Math.min(2,e.data.byteLength));if(t[0]===31&&t[1]===139){let t=(async()=>{let t=await new Response(new Blob([e.data]).stream().pipeThrough(new DecompressionStream(`gzip`))).text(),n=this._parseDataChannelMessage(t);return n===null||this._requiresOrderedDelivery(n)?n:(this._routeDataChannelMessage(n),null)})().catch(e=>(this._setError(`failed to decompress data channel message: `+e),null));this._recvQueue=this._recvQueue.then(async()=>{let e=await t;if(e!==null)return this._routeDataChannelMessage(e)}).catch(e=>this._setError(`failed to handle data channel message: `+e));return}this._setError(`unexpected binary data channel message`);return}if(e.data===`_gz,1`){this._gzTx=!0;return}let t=this._parseDataChannelMessage(e.data);if(t!==null){if(!this._requiresOrderedDelivery(t)){try{this._routeDataChannelMessage(t)}catch(e){this._setError(`failed to handle data channel message: `+e)}return}this._recvQueue=this._recvQueue.then(()=>this._routeDataChannelMessage(t)).catch(e=>this._setError(`failed to handle data channel message: `+e))}}_requiresOrderedDelivery(e){return typeof e.type==`string`&&(e.type.startsWith(`clipboard-msg`)||e.type===`server_settings`)}_parseDataChannelMessage(e){var t;try{t=JSON.parse(e)}catch(t){return t instanceof SyntaxError?this._setError(`error parsing data channel message as JSON: `+e):this._setError(`failed to parse data channel message: `+e),null}return this._setDebug(`data channel message: `+e),t}_routeDataChannelMessage(e){if(e.type===`pipeline`)this._setStatus(e.data.status);else if(e.type===`stream_info`)this.onstreaminfo!==null&&this.onstreaminfo(e.data);else if(e.type===`stream_stats`)this.onstreamstats!==null&&this.onstreamstats(e.data);else if(typeof e.type==`string`&&e.type.startsWith(`clipboard-msg`)){if(typeof this.onclipboardcontent==`function`)return this.onclipboardcontent(e)}else if(e.type===`cursor`){if(this.oncursorchange!==null&&e.data!==null){let t={curdata:e.data.curdata,width:e.data.width,height:e.data.height,hotx:e.data.hotx,hoty:e.data.hoty,handle:e.data.handle};this._setDebug(`received new cursor contents, ${JSON.stringify(t)}`),this.oncursorchange(t)}}else if(e.type===`system`){if(e.data!=null&&e.data.action!=null){var t=e.data.action;this._setDebug(`received system msg, action: `+t),this.onsystemaction!==null&&this.onsystemaction(t)}}else e.type===`ping`?(this._setDebug(`received server ping: `+JSON.stringify(e.data)),this.sendDataChannelMessage(`pong,`+new Date().getTime()/1e3)):e.type===`latency_measurement`?this.onlatencymeasurement!==null&&this.onlatencymeasurement(e.data.latency_ms):e.type===`server_settings`?this.onserversettings!==null&&this.onserversettings(e.data):e.type===`display_config_update`?this.ondisplayconfig!==null&&this.ondisplayconfig(e.data):e.type===`print_document`?this.onprintdocument!==null&&this.onprintdocument(e.data):this._setError(`Unhandled message received: `+e.type)}_handleConnectionStateChange(e){switch(e){case`connected`:this._setStatus(`Connection complete`),this._connected=!0;break;case`disconnected`:this._setError(`Peer connection disconnected`),this._send_channel!==null&&this._send_channel.readyState===`open`&&this._send_channel.close(),this.element.load();break;case`failed`:this._setError(`Peer connection failed`),this.element.load()}}dataChannelBufferedAmount(){return this._send_channel&&this._send_channel.readyState===`open`?this._send_channel.bufferedAmount:0}dataChannelOpen(){return this._send_channel!==null&&this._send_channel.readyState===`open`}async waitForDataChannelDrain(e=1048576){if(this._sendQueue)try{await this._sendQueue}catch{}let t=this._send_channel;!t||t.readyState!==`open`||t.bufferedAmount<=e||(t.bufferedAmountLowThreshold=e,await new Promise(n=>{let r=()=>{t.removeEventListener(`bufferedamountlow`,r),n()};t.addEventListener(`bufferedamountlow`,r),(t.readyState!==`open`||t.bufferedAmount<=e)&&r()}))}sendMotionMessage(e){let t=this._motion_channel;if(t!==null&&t.readyState===`open`){t.send(e);return}this.sendDataChannelMessage(e)}sendDataChannelMessage(e){if(this._send_channel!==null&&this._send_channel.readyState===`open`){if(!this._gzTx){this._send_channel.send(e);return}this._sendQueue=typeof e==`string`&&e.length>=512?this._sendQueue.then(async()=>{let t=await new Response(new Blob([e]).stream().pipeThrough(new CompressionStream(`gzip`))).arrayBuffer();this._send_channel&&this._send_channel.readyState===`open`&&this._send_channel.send(t)}).catch(()=>{}):this._sendQueue.then(()=>{this._send_channel&&this._send_channel.readyState===`open`&&this._send_channel.send(e)}).catch(()=>{})}}onGamepadDisconnect(e){this._setStatus(`gamepad: `+e+`, disconnected`)}getConnectionStats(){var e=this.peerConnection,t={general:{bytesReceived:0,bytesSent:0,connectionType:`NA`,currentRoundTripTime:null,availableReceiveBandwidth:0},video:{bytesReceived:0,decoder:`NA`,frameHeight:0,frameWidth:0,framesPerSecond:0,packetsReceived:0,packetsLost:0,codecName:`NA`,jitterBufferDelay:0,jitterBufferEmittedCount:0},audio:{bytesReceived:0,packetsReceived:0,packetsLost:0,codecName:`NA`,jitterBufferDelay:0,jitterBufferEmittedCount:0,concealedSamples:0,concealmentEvents:0,totalSamplesReceived:0,packetsDiscarded:0},data:{bytesReceived:0,bytesSent:0,messagesReceived:0,messagesSent:0}};return new Promise(function(n,r){e.getStats().then(e=>{var r={transports:{},candidatePairs:{},selectedCandidatePairId:null,remoteCandidates:{},localCandidates:{},outbound:{},codecs:{},videoRTP:null,videoTrack:null,audioRTP:null,audioTrack:null,dataChannel:null},i=[];e.forEach(e=>{i.push(e),e.type===`transport`?r.transports[e.id]=e:e.type===`candidate-pair`?(r.candidatePairs[e.id]=e,e.selected===!0&&(r.selectedCandidatePairId=e.id)):e.type===`inbound-rtp`?e.kind===`video`?r.videoRTP=e:e.kind===`audio`&&(r.audioRTP=e):e.type===`track`?e.kind===`video`?r.videoTrack=e:e.kind===`audio`&&(r.audioTrack=e):e.type===`data-channel`?r.dataChannel=e:e.type===`remote-candidate`?r.remoteCandidates[e.id]=e:e.type===`local-candidate`?r.localCandidates[e.id]=e:e.type===`outbound-rtp`?r.outbound[e.kind]=e:e.type===`codec`&&(r.codecs[e.id]=e)});var a=r.videoRTP;if(a!==null){t.video.bytesReceived=a.bytesReceived,t.video.decoder=a.decoderImplementation||`unknown`,t.video.frameHeight=a.frameHeight,t.video.frameWidth=a.frameWidth,t.video.framesPerSecond=a.framesPerSecond,t.video.packetsReceived=a.packetsReceived,t.video.packetsLost=a.packetsLost;var o=r.codecs[a.codecId];o!==void 0&&(t.video.codecName=o.mimeType.split(`/`)[1].toUpperCase())}var s=r.audioRTP;if(s!==null){t.audio.bytesReceived=s.bytesReceived,t.audio.packetsReceived=s.packetsReceived,t.audio.packetsLost=s.packetsLost,s.concealedSamples!==void 0&&(t.audio.concealedSamples=s.concealedSamples),s.concealmentEvents!==void 0&&(t.audio.concealmentEvents=s.concealmentEvents),s.totalSamplesReceived!==void 0&&(t.audio.totalSamplesReceived=s.totalSamplesReceived),s.packetsDiscarded!==void 0&&(t.audio.packetsDiscarded=s.packetsDiscarded);var o=r.codecs[s.codecId];o!==void 0&&(t.audio.codecName=o.mimeType.split(`/`)[1].toUpperCase())}var c=r.dataChannel;if(c!==null&&(t.data.bytesReceived=c.bytesReceived,t.data.bytesSent=c.bytesSent,t.data.messagesReceived=c.messagesReceived,t.data.messagesSent=c.messagesSent),Object.keys(r.transports).length>0){var l=r.transports[Object.keys(r.transports)[0]];t.general.bytesReceived=l.bytesReceived,t.general.bytesSent=l.bytesSent,r.selectedCandidatePairId=l.selectedCandidatePairId}else r.selectedCandidatePairId!==null&&(t.general.bytesReceived=r.candidatePairs[r.selectedCandidatePairId].bytesReceived,t.general.bytesSent=r.candidatePairs[r.selectedCandidatePairId].bytesSent);if(r.selectedCandidatePairId!==null){var u=r.candidatePairs[r.selectedCandidatePairId];if(u!==void 0){u.availableIncomingBitrate!==void 0&&(t.general.availableReceiveBandwidth=u.availableIncomingBitrate),u.currentRoundTripTime!==void 0&&(t.general.currentRoundTripTime=u.currentRoundTripTime);var d=r.remoteCandidates[u.remoteCandidateId];d!==void 0&&(t.general.connectionType=d.candidateType)}}t.general.packetsReceived=t.video.packetsReceived+t.audio.packetsReceived,t.general.packetsLost=t.video.packetsLost+t.audio.packetsLost,r.videoRTP!==null&&(t.video.jitterBufferDelay=r.videoRTP.jitterBufferDelay,t.video.jitterBufferEmittedCount=r.videoRTP.jitterBufferEmittedCount),r.audioRTP!==null&&(t.audio.jitterBufferDelay=r.audioRTP.jitterBufferDelay,t.audio.jitterBufferEmittedCount=r.audioRTP.jitterBufferEmittedCount),t.reports=r,t.allReports=i,n(t)}).catch(e=>r(e))})}playStream(){this.element.load();var e=this.element.play();e!==void 0&&e.then(()=>{this._setDebug(`Stream is playing.`)}).catch(()=>{this.onplaystreamrequired===null?this._setDebug(`Stream play failed and no onplaystreamrequired was bound.`):this.onplaystreamrequired()})}connect(){if(this.peerConnection=new RTCPeerConnection(this.rtcPeerConfig),this.peerConnection.ontrack=this._ontrack.bind(this),this.peerConnection.onicecandidate=this._onPeerICE.bind(this),this.peerConnection.ondatachannel=this._onPeerdDataChannel.bind(this),this.peerConnection.onconnectionstatechange=()=>{this._handleConnectionStateChange(this.peerConnection.connectionState),this._setConnectionState(this.peerConnection.connectionState)},this.forceTurn){this._setStatus(`forcing use of TURN server`);let e=this.peerConnection.getConfiguration();e.iceTransportPolicy=`relay`,this.peerConnection.setConfiguration(e)}this.signaling.peer_id=this.peer_id,this.signaling.connect()}reset(){this.cursor_cache=new Map;var e=this.peerConnection.signalingState;this._send_channel!==null&&this._send_channel.readyState===`open`&&this._send_channel.close(),this.peerConnection!==null&&this.peerConnection.close(),e===`stable`?this.connect():setTimeout(()=>{this.connect()},3e3)}},Ve=class{constructor(e,t,n,r,i,a,o){this._server=e,this.capabilities=null,this.peer_id=1,this._ws_conn=null,this.onstatus=null,this.onfatalretry=null,this.onerror=null,this.ondebug=null,this.onice=null,this.onsdp=null,this.ondisconnect=null,this.state=`disconnected`,this.retry_count=0,this._retry_timer=null,this._intentional_close=!1,this.currRes=null,this.peer_type=`client`,this.client_type=t,this.server_peer_id=null,this.client_slot=n,this.client_strict_viewer=r,this.client_token=i,this.display_id=a||`primary`,this.display_position=o||`right`,this.onshowalert=null}_setStatus(e){this.onstatus!==null&&this.onstatus(e)}_setDebug(e){this.ondebug!==null&&this.ondebug(e)}_setError(e){this.onerror!==null&&this.onerror(e)}_setSDP(e){this.onsdp!==null&&this.onsdp(e)}_setICE(e){this.onice!==null&&this.onice(e)}async _onServerOpen(){this.state=`connected`;let e={client_type:this.client_type,client_slot:this.client_slot,client_strict_viewer:this.client_strict_viewer,client_token:this.client_token,display_id:this.display_id,display_position:this.display_position};if(this.capabilities)try{e.fullcolor_codecs=await this.capabilities()}catch{}this._ws_conn&&this._ws_conn.readyState===WebSocket.OPEN&&(this._ws_conn.send(`HELLO ${this.peer_type} ${JSON.stringify(e)}`),this._setStatus(`Registering with server, peer type: `+this.peer_type+`, client type: `+this.client_type),this.retry_count=0)}_scheduleRetry(){this._retry_timer||=(this.retry_count++,setTimeout(()=>{this._retry_timer=null,this.retry_count>3?this.onfatalretry===null?window.location.reload():this.onfatalretry():this.connect()},3e3))}_onServerError(){this._setStatus(`Connection error, retry in 3 seconds.`),this._ws_conn.readyState===this._ws_conn.CLOSED&&this._scheduleRetry()}_setupCall(){this._setStatus(`Initiating session with server.`),this._ws_conn.send(`SESSION server`)}_onServerMessage(e){if(this._setDebug(`server message: `+e.data),e.data===`HELLO`){this._setStatus(`Registered with server.`),this._setupCall();return}if(e.data.startsWith(`SESSION_OK`)){this._setStatus(`Session established with server.`),this.server_peer_id=e.data.split(` `)[1];return}if(e.data.startsWith(`ERROR`)){e.data===`ERROR peer server not found`&&(this._setError(`Server not found. Retrying...`),setTimeout(()=>{this._setupCall()},1e3));return}var t;try{t=e.data.substring(e.data.indexOf(` `)+1),t=JSON.parse(t)}catch(t){t instanceof SyntaxError?this._setError(`error parsing message as JSON: `+e.data):this._setError(`failed to parse message: `+e.data);return}if(t.sdp!=null)this._setSDP(new RTCSessionDescription(t.sdp));else if(t.ice!=null){var n=new RTCIceCandidate(t.ice);this._setICE(n)}else this._setError(`unhandled JSON message: `+t)}_onServerClose(e){if(this.state===`connecting`){this.state=`disconnected`,this._scheduleRetry();return}this.state=`disconnected`,this._setError(`Server closed connection.`);let t=this._intentional_close;this._intentional_close=!1,this.ondisconnect!==null&&(e.code===4e3?this.onshowalert!==null&&this.onshowalert(e.reason):e.code===4001?this.onshowalert!==null&&this.onshowalert(e.reason||`Session superseded by a new connection. Reload to take over.`):(e.code===1e3||e.code===1001)&&t?this.ondisconnect(!1):(console.log(`Reconnecting due to server-side connection closure.`),this.ondisconnect(!0)))}connect(){this.state=`connecting`,this._setStatus(`Connecting to server.`),this._ws_conn=new WebSocket(this._server),this._ws_conn.addEventListener(`open`,this._onServerOpen.bind(this)),this._ws_conn.addEventListener(`error`,this._onServerError.bind(this)),this._ws_conn.addEventListener(`message`,this._onServerMessage.bind(this)),this._ws_conn.addEventListener(`close`,this._onServerClose.bind(this))}disconnect(){this._intentional_close=!0,this._ws_conn.close()}sendICE(e){this._setDebug(`sending ice candidate: `+JSON.stringify(e)),this._ws_conn.send(`${this.server_peer_id} ${JSON.stringify({ice:e})}`)}sendSDP(e){this._setDebug(`sending local sdp: `+JSON.stringify(e)),this._ws_conn.send(`${this.server_peer_id} ${JSON.stringify({sdp:e})}`)}};function He({useCssScaling:e,localScale:t,manual:n,displayId:r,layouts:i,shared:a,wayland:o}){let s=window.devicePixelRatio||1,c=e&&!n?s/(Number.isFinite(t)&&t>0?t:1):s;if(o||a||n||!r||r===`primary`)return c;let l=Number(i&&i.primary&&i.primary.scale);return!(l>0)||l>=c?c:Math.round(l*100)/100}var Ue=[96,120,144,168,192,216,240,264,288],L=1080;function We(e){return Ue.reduce((t,n)=>Math.abs(n-e)<Math.abs(t-e)?n:t)}function Ge(){let e=window.devicePixelRatio||1;return We(Math.round(e*4)*24)}function Ke(e,t){let n=Math.min(Number(e)||0,Number(t)||0);return n>0?We(96*n/L):Ge()}function qe({stream:e,css:t,realized:n,density:r}){return!e||!t||!n||!(t[0]>0)||!(t[1]>0)||e[0]!==n[0]||e[1]!==n[1]?r:Math.max(e[0]/t[0],e[1]/t[1])}function Je(e,t){return{__clipDigest:!0,byteLength:e,hash:t}}async function Ye(e){let t=await createImageBitmap(e);try{let e=document.createElement(`canvas`);return e.width=t.width,e.height=t.height,e.getContext(`2d`).drawImage(t,0,0),await new Promise((t,n)=>e.toBlob(e=>e?t(e):n(Error(`PNG encode failed`)),`image/png`))}finally{t.close()}}function Xe(){return typeof navigator<`u`&&navigator.clipboard?null:typeof window<`u`&&window.isSecureContext===!1?`this page is not a secure context, so the browser exposes no clipboard (serve it over https, or from localhost)`:`this browser exposes no clipboard API`}async function Ze(e,t,n){if(t===`image/png`){await navigator.clipboard.write([new ClipboardItem({"image/png":e})]);return}let r=n?n(e).catch(()=>Ye(e)):Ye(e);await navigator.clipboard.write([new ClipboardItem({"image/png":r})])}var Qe=`application/x-selkies-clipboard-flavours`;function $e({html:e,text:t}){let n={"text/html":e};return t&&(n[`text/plain`]=t),new TextEncoder().encode(JSON.stringify(n)).buffer}function et(e){let t=JSON.parse(new TextDecoder().decode(e));return{html:t[`text/html`]||``,text:t[`text/plain`]||``}}function tt({html:e,text:t}){let n={"text/html":new Blob([e],{type:`text/html`})};return t&&(n[`text/plain`]=new Blob([t],{type:`text/plain`})),new ClipboardItem(n)}function nt(e){return navigator.clipboard.write([tt(e)])}async function rt(e){let t=async()=>{let e=await navigator.clipboard.readText().catch(()=>``);return e?{kind:`text`,text:e}:null};if(!e){let e=await navigator.clipboard.readText();return e?{kind:`text`,text:e}:null}let n;try{n=await navigator.clipboard.read()}catch(e){if(e&&e.name===`DataError`)return t();throw e}if(!n||n.length===0)return null;let r=n[0],i=r.types.find(e=>e.startsWith(`image/`));try{if(i)return{kind:`image`,blob:await r.getType(i),mime:i};if(r.types.includes(`text/html`)){let e=await(await r.getType(`text/html`)).text(),t=r.types.includes(`text/plain`)?await(await r.getType(`text/plain`)).text():``;if(e)return{kind:`flavours`,html:e,text:t}}if(r.types.includes(`text/plain`)){let e=await(await r.getType(`text/plain`)).text();return e?{kind:`text`,text:e}:null}}catch(e){if(e&&e.name===`DataError`)return t();throw e}return null}function it(e){let t=null,n=null,r=0,i=0,a=!1;function o(e){if(!e)return 0;let t=e.endsWith(`==`)?2:+!!e.endsWith(`=`);return e.length/4*3-t}function s(){t=null,n=null,r=0,i=0,a=!1}return{begin(i,o){this.reset(),n=i,r=o,t=e(i),a=!0},push(e){a&&(t.push(e),i+=o(e))},finish(){if(!a)return Promise.reject(Error(`no transfer in progress`));let e=t.finish();return s(),e},reset(){t&&t.abort(),s()},get inProgress(){return a},get mimeType(){return n},get totalSize(){return r},get receivedSize(){return i}}}function at(){let e=0,t=!1,n=!1;return{arm(){t=!0,n=!0,e=0},armLegacyWindow(t){e=Date.now()+t},consume(){if(n)return n=!1,!0;if(t||!e)return!1;let r=Date.now()<e;return e=0,r}}}var ot=1e3;function st({isChromium:e,isSharedMode:t,canSync:n,canRead:r,binaryEnabled:i,sendClipboardData:a,dedupeText:o=!1,getDeferredWriteInFlight:s=null}){let c=null,l=null,u=!1,d=0,f=-1/0;function p(){return d>0||Date.now()-f<ot}async function m(e){let t,n=new Promise(e=>{t=e});c=n;try{await e}finally{t(),c===n&&(c=null)}}async function h(){if(window.isSecureContext&&navigator.clipboard&&!t()&&n()&&r()){if(s)for(let e=0;e<2;e++){let e=s();if(!e)break;try{await e}catch{}if(!s())break}p()||await m((async()=>{try{let e=await rt(i());if(!e||p())return;if(e.kind===`image`){let t=await e.blob.arrayBuffer();if(p())return;await a(t,e.mime),console.log(`Sent binary clipboard: ${e.mime}, size: ${e.blob.size} bytes`)}else e.kind===`flavours`?(!o||e.html!==l)&&(await a($e(e),Qe),l=e.html,console.log(`Sent clipboard markup with its text, ${e.html.length} characters`)):(!o||e.text!==l)&&(await a(e.text),l=e.text,console.log(`Sent clipboard text to server`))}catch(e){e.name!==`NotFoundError`&&e.name!==`DataError`&&e.name!==`NotAllowedError`&&!(e.message&&e.message.includes(`not focused`))&&console.warn(`Could not read clipboard: ${e.name} - ${e.message}`)}})())}}async function ee(e,t,n){d++,await m((async()=>{try{await a(e&&typeof e.arrayBuffer==`function`?await e.arrayBuffer():e,t,n)}finally{d--,f=Date.now()}})())}async function te(){if(!u&&(u=!0,e&&!t()&&document.hasFocus()&&navigator.permissions&&navigator.permissions.query))try{(await navigator.permissions.query({name:`clipboard-read`})).state===`granted`&&h()}catch{}}return{readAndSend:h,sendExplicit:ee,maybeInitial:te,getSendInFlight:()=>c}}function ct(){let e=null,t=0,n=null;function r(e){return!!e&&(e.name===`NotAllowedError`||e.name===`SecurityError`)}function i(e){n=e,e.finally(()=>{n===e&&(n=null)})}function a(t){return Promise.resolve().then(()=>t.attempt()).then(()=>(t.onSuccess&&t.onSuccess(),!0),n=>r(n)?((!e||e.seq<t.seq)&&(e=t),!1):(t.onFailure&&t.onFailure(n),!1))}function o(){let t=e;t&&(e=null,i(a(t)))}for(let e of[`pointerdown`,`keydown`,`focus`])window.addEventListener(e,o,!0);document.addEventListener(`visibilitychange`,()=>{document.hidden||o()},!0);function s(e,{onSuccess:n,onFailure:r}={}){let o=a({attempt:e,onSuccess:n,onFailure:r,seq:++t});return i(o),o}return{write:s,flush:o,getInFlight:()=>n}}var lt=262144;function ut(e){let t=e.length>lt;return{type:`clipboardContentUpdate`,text:t?e.slice(0,lt):e,truncated:t,totalLength:e.length}}function dt({sendRequest:e,digestBytes:t,isChromium:n=!0,canRead:r=()=>!0}){let i=``,a=null,o=`text/plain`,s=null,c=null,l=[];function u(e){s=e,c=null}function d(e,t){for(let n=0;n<t.length;n++)e=(e<<5)+e+t[n]|0;return e}function f(e,t){if(typeof e==`string`){let t=5381;for(let n=0;n<e.length;n++)t=(t<<5)+t+e.charCodeAt(n)|0;return{full:`t:${e.length}:${t}`,legacy:null}}if(e&&e.__clipDigest){let n=t||``;return{full:`b:${n}:${e.byteLength}:${e.hash}`,legacy:`b:${n}:${e.byteLength}`}}let n=null;e instanceof Uint8Array?n=[e]:e instanceof ArrayBuffer?n=[new Uint8Array(e)]:Array.isArray(e)&&(n=e.map(e=>e instanceof Uint8Array?e:new Uint8Array(e)));let r=t||``;if(n){let e=5381,t=0;for(let r of n)t+=r.length,e=d(e,r);return{full:`b:${r}:${t}:${e}`,legacy:`b:${r}:${t}`}}return{full:`b:${r}:${e&&(e.byteLength===void 0?e.size:e.byteLength)}`,legacy:null}}function p(e,t){return f(e,t).full}function m(e,t){let{full:n,legacy:r}=f(e,t);return n===s||n===c?!1:r===null||r!==s&&r!==c}function h(e,t){u(p(e,t))}function ee(e,t,n,r){if(typeof e==`string`&&(i=e,u(p(e))),t&&(a=t,u(p(r??t,n||t.type))),n&&(o=n),l.length===0)return;let s=l;l=[];for(let n of s)if(!n.settled)try{n.wantBinary?t&&t!==n.baselineBlob?n.resolve(t):l.push(n):typeof e==`string`&&e!==n.baselineText?n.resolve(e):l.push(n)}catch{}}async function te(){if(!n||!r())return;let e=s;try{let n=await navigator.clipboard.read();for(let r of n){let n=r.types.find(e=>e!==`text/plain`);if(!n)continue;let i=await(await r.getType(n)).arrayBuffer(),a=p((t?await t(i):null)||new Uint8Array(i),n);s===e&&(c=a);return}}catch{}}function g(t){try{e()}catch{}return new Promise((e,n)=>{let r={wantBinary:!!t,resolve:e,settled:!1,baselineText:i,baselineBlob:a},o=(e,t)=>{if(r.settled)return;r.settled=!0;let n=l.indexOf(r);n!==-1&&l.splice(n,1),e(t)};r.resolve=t=>o(e,t),l.push(r),setTimeout(()=>{t&&a&&a!==r.baselineBlob?o(e,a):!t&&i&&i!==r.baselineText?o(e,i):o(n,Error(`Server clipboard request timed out with no fresh value`))},2e3)})}async function ne(e){let t=``;try{t=await e}catch{return}if(typeof t!=`string`||!t)return;let n=document.createElement(`textarea`);n.value=t,n.setAttribute(`readonly`,``),n.style.position=`fixed`,n.style.top=`-9999px`,n.style.left=`-9999px`,n.style.opacity=`0`,document.body.appendChild(n);try{n.focus(),n.select(),n.setSelectionRange(0,n.value.length),document.execCommand(`copy`)||console.warn(`execCommand("copy") fallback returned false.`)}catch(e){console.warn(`execCommand("copy") fallback threw: ${e&&e.name} - ${e&&e.message}`)}finally{document.body.removeChild(n)}}return{sig:p,shouldSend:m,markSynced:h,resolveServer:ee,captureLocalImageSig:te,request:g,copyViaExecCommand:ne,get lastText(){return i},get lastBlob(){return a},get lastMime(){return o}}}function ft({isChromium:e,clipboardSync:t,sendClipboardData:n,canSync:r,canRead:i,canWrite:a,binaryEnabled:o,getSendInFlight:s,getDeferredWriteInFlight:c}){function l(){let e=document.activeElement;return!(!e||e.id===`overlayInput`||e.tagName!==`INPUT`&&e.tagName!==`TEXTAREA`&&e.tagName!==`SELECT`&&!e.isContentEditable)}let u=[],d=!1;function f(){d=!1;for(let e of u.splice(0))try{let t=new KeyboardEvent(e.type,e);Object.defineProperty(t,"__selkiesClipReplay",{value:!0}),window.dispatchEvent(t)}catch{}}function p(){for(let e=u.length-1;e>=0;e--)u[e].type===`keydown`&&u.splice(e,1);f()}let m=[`ControlLeft`,`ControlRight`,`MetaLeft`,`MetaRight`];function h(e){if(e.__selkiesClipReplay)return;let t=d&&e.type===`keyup`&&m.includes(e.code);if(e.code!==`KeyV`&&!t)return;let n=(e.ctrlKey||e.metaKey)&&!e.altKey,r=c?c():null;if((t||e.code===`KeyV`&&(n&&(s()||r)||d))&&(e.preventDefault(),e.stopImmediatePropagation(),u.push(e),!d)){d=!0;let e=performance.now(),t=()=>{let n=[],r=s();r&&n.push(r);let i=c?c():null;if(i&&n.push(i),n.length===0){f();return}let a=1e4-(performance.now()-e);if(a<=0){p();return}Promise.race([Promise.all(n).then(()=>`settled`,()=>`failed`),new Promise(e=>setTimeout(()=>e(`timeout`),a))]).then(e=>{e===`settled`?t():p()})};t()}}function ee(e){if(r()&&(e.ctrlKey||e.metaKey)&&!e.altKey&&!e.repeat&&!l()&&(e.key||``).toLowerCase()===`c`&&a()){let e=t.request(!1),n={"text/plain":e.then(e=>new Blob([typeof e==`string`?e:t.lastText||``],{type:`text/plain`}))},r=null;try{r=navigator.clipboard.write([new ClipboardItem(n)])}catch(n){console.warn(`navigator.clipboard.write unavailable on Ctrl+C, using execCommand: ${n&&n.name}`),t.copyViaExecCommand(e)}r&&r.catch&&r.catch(n=>{console.warn(`navigator.clipboard.write rejected on Ctrl+C, using execCommand: ${n&&n.name} - ${n&&n.message}`),t.copyViaExecCommand(e)})}}function te(e){if(!r()||!i()||l())return;let t=e.clipboardData;if(!t)return;if(o()&&t.items)for(let e=0;e<t.items.length;e++){let r=t.items[e];if(r.kind===`file`&&r.type&&r.type.startsWith(`image/`)){let e=r.getAsFile();if(e){e.arrayBuffer().then(e=>n(e,r.type)).catch(e=>console.warn(`Paste image read failed: ${e&&e.name}`));return}}}let a=t.getData(`text/plain`);a&&n(a)}function g(){window.addEventListener(`keydown`,h,!0),window.addEventListener(`keyup`,h,!0),e||(window.addEventListener(`keydown`,ee,!0),window.addEventListener(`paste`,te,!0))}function ne(){window.removeEventListener(`keydown`,h,!0),window.removeEventListener(`keyup`,h,!0),e||(window.removeEventListener(`keydown`,ee,!0),window.removeEventListener(`paste`,te,!0))}return{wire:g,unwire:ne}}var pt=`selkies_token`;function mt(){if(typeof window>`u`||!window.location)return``;try{return new URLSearchParams(window.location.search).get(`token`)||``}catch{return``}}function ht(e){let t=Object.assign({},e||{}),n=mt();return n&&!(`Authorization`in t)&&(t.Authorization=`Bearer ${n}`),t}function gt(){let e=mt();if(!e||typeof document>`u`)return;let t=[`path=${he()}/api/`,`SameSite=Strict`];window.location.protocol===`https:`&&t.push(`Secure`);try{document.cookie=`${pt}=${encodeURIComponent(e)}; ${t.join(`; `)}`}catch{}}var _t=67108864;function vt({canUpload:e=()=>!0}={}){let t=!1;function n(e){window.postMessage({type:`fileUpload`,payload:e},window.location.origin)}function r(){return t?(console.warn(`Simultaneous uploading of files with distinct upload operations is not supported yet`),n({status:`warning`,fileName:`_N/A_`,message:`Please let the ongoing upload complete.`}),!1):(t=!0,!0)}function i(e,t,n,r,i){return new Promise((a,o)=>{let s=new XMLHttpRequest;s.open(`POST`,e,!0),s.withCredentials=!0,s.setRequestHeader(`Content-Type`,`application/octet-stream`),s.setRequestHeader(`X-Upload-Path`,encodeURIComponent(t));for(let[e,t]of Object.entries(ht(r)))s.setRequestHeader(e,t);s.upload.onprogress=i,s.onload=()=>{s.status>=200&&s.status<300?a():o(Error(`upload failed (${s.status}): ${String(s.responseText||``).slice(0,160)}`))},s.onerror=()=>{o(Error(`network error uploading ${t}`))},s.send(n)})}async function a(e,t){n({status:`start`,fileName:t,fileSize:e.size});let r=(r,i)=>n({status:r,fileName:t,fileSize:e.size,...i}),a=t=>e.size>0?Math.min(100,Math.round(t/e.size*100)):0;try{let n=new URL(`api/upload`,window.location.href).href;if(e.size<=_t)await i(n,t,e,null,t=>{let n=t.lengthComputable&&e.size>0?Math.min(100,Math.round(t.loaded/t.total*100)):0;r(`progress`,{progress:n})});else{let o=window.crypto&&crypto.randomUUID?crypto.randomUUID():`${Date.now()}-${Math.random().toString(36).slice(2)}`;for(let s=0;s<e.size;){let c=Math.min(s+_t,e.size),l={"X-Upload-Id":o,"X-Upload-Offset":String(s),"X-Upload-Total":String(e.size)};c>=e.size&&(l[`X-Upload-Final`]=`1`);let u=s;await i(n,t,e.slice(s,c),l,e=>{e.lengthComputable&&r(`progress`,{progress:a(u+e.loaded)})}),s=c,r(`progress`,{progress:a(s)})}}r(`progress`,{progress:100}),r(`end`)}catch(e){throw r(`error`,{message:e&&e.message?e.message:`error during upload of ${t}: ${e}`}),e}}function o(e){return new Promise((t,n)=>e.file(t,n))}async function s(e,t=``){let r;if(e.fullPath&&typeof e.fullPath==`string`&&e.fullPath!==e.name&&(e.fullPath.includes(`/`)||e.fullPath.includes(`\\`))?(r=e.fullPath,r.startsWith(`/`)&&(r=r.substring(1))):r=t?`${t}/${e.name}`:e.name,e.isFile)try{await a(await o(e),r)}catch(e){console.error(`Error processing file ${r}: ${e}`),n({status:`error`,fileName:r,message:`Error processing file: ${e.message||e}`})}else if(e.isDirectory){let t=e.createReader(),n;do{n=await new Promise((e,n)=>t.readEntries(e,n));for(let e of n)await s(e,r)}while(n.length>0)}}function c(){if(!e()){console.log(`File upload blocked (shared/viewer session).`);return}let t=document.getElementById(`globalFileInput`);if(!t){console.error(`Global file input not found!`);return}t.click()}async function l(i){let o=i.target.files;if(!e()||!o||o.length===0){i.target.value=null;return}if(!r()){i.target.value=null;return}console.log(`File input changed, processing ${o.length} files sequentially.`);try{for(let e=0;e<o.length;e++){let t=o[e];await a(t,t.name)}}catch(e){let t=`An error occurred during the file input upload process: ${e.message||e}`;console.error(t),n({status:`error`,fileName:`N/A`,message:t})}finally{i.target.value=null,t=!1}}function u(t){t.preventDefault(),t.dataTransfer.dropEffect=e()?`copy`:`none`}async function d(i){if(i.preventDefault(),i.stopPropagation(),!e()){console.log(`File upload via drag-drop blocked (shared/viewer session).`);return}if(r())try{let e=[];if(i.dataTransfer.items)for(let t=0;t<i.dataTransfer.items.length;t++){let n=i.dataTransfer.items[t];if(n.kind!==`file`)continue;let r=null;typeof n.webkitGetAsEntry==`function`?r=n.webkitGetAsEntry():typeof n.getAsEntry==`function`&&(r=n.getAsEntry()),r&&e.push(r)}else if(i.dataTransfer.files.length>0){for(let e=0;e<i.dataTransfer.files.length;e++)await a(i.dataTransfer.files[e],i.dataTransfer.files[e].name);return}try{for(let t of e)await s(t)}catch(e){n({status:`error`,fileName:`N/A`,message:`Error during sequential upload: ${e.message||e}`})}}finally{t=!1}}return{uploadFileObject:a,handleRequestFileUpload:c,handleFileInputChange:l,handleDragOver:u,handleDrop:d}}var yt="const e=32768,t=5381;function n(e,t){for(let n=0;n<t.length;n++)e=(e<<5)+e+t[n]|0;return e}function r(t){let n=new TextEncoder().encode(t),r=``;for(let t=0;t<n.length;t+=e){let i=n.subarray(t,t+e);r+=String.fromCharCode.apply(null,i)}return btoa(r)}function i(e){let t=atob(e),n=t.length,r=new Uint8Array(n);for(let e=0;e<n;e++)r[e]=t.charCodeAt(e);return{text:new TextDecoder().decode(r),byteLength:n}}function a(e){let t=atob(e),n=t.length,r=new Uint8Array(n);for(let e=0;e<n;e++)r[e]=t.charCodeAt(e);return r}function o(t){let n=``;for(let r=0;r<t.length;r+=e){let i=t.subarray(r,r+e);n+=String.fromCharCode.apply(null,i)}return btoa(n)}function s(e,t){let r=e.remainder+t,i=r.length-r.length%4;if(e.remainder=r.slice(i),!i)return;let o=a(r.slice(0,i));e.parts.push(o),e.bytes+=o.length,e.hash=n(e.hash,o)}function c(e){if(e.remainder){let t=a(e.remainder);e.parts.push(t),e.bytes+=t.length,e.hash=n(e.hash,t),e.remainder=``}let t=new Uint8Array(e.bytes),r=0;for(let n of e.parts)t.set(n,r),r+=n.length;return e.parts=[],t}const l=/* @__PURE__ */ new Map;async function u(e,t){let n=null;try{n=await createImageBitmap(t);let r=new OffscreenCanvas(n.width,n.height);r.getContext(`2d`).drawImage(n,0,0);let i=await r.convertToBlob({type:`image/png`});self.postMessage({id:e,success:!0,result:i,mimeType:`image/png`,byteLength:i.size})}catch(t){self.postMessage({id:e,success:!1,error:t.message})}finally{n&&n.close()}}self.onmessage=function(e){let{id:d,action:f,payload:p,mimeType:m}=e.data;try{if(f===`DECODE_BEGIN`){l.set(d,{mimeType:m,parts:[],remainder:``,bytes:0,hash:t});return}if(f===`DECODE_CHUNK`){let e=l.get(d);e&&s(e,p);return}if(f===`DECODE_ABORT`){l.delete(d);return}if(f===`DECODE_END`){let e=l.get(d);if(l.delete(d),!e){self.postMessage({id:d,success:!1,error:`no transfer in progress`});return}let t=c(e);e.mimeType===`text/plain`?self.postMessage({id:d,success:!0,mimeType:e.mimeType,result:new TextDecoder().decode(t),byteLength:t.byteLength,hash:e.hash}):self.postMessage({id:d,success:!0,mimeType:e.mimeType,result:t.buffer,byteLength:t.byteLength,hash:e.hash},[t.buffer]);return}if(f===`HASH_BYTES`){let e=new Uint8Array(p);self.postMessage({id:d,success:!0,byteLength:e.byteLength,hash:n(t,e)});return}if(f===`REENCODE_PNG`){u(d,p);return}if(f===`ENCODE_BINARY_TO_B64`){let r=new Uint8Array(p),i=o(r);self.postMessage({id:d,success:!0,result:i,byteLength:r.byteLength,hash:n(e.data.hash===void 0?t:e.data.hash,r)})}else if(f===`ENCODE_TEXT_TO_B64`){let e=r(p);self.postMessage({id:d,success:!0,result:e})}else if(f===`DECODE_FROM_B64`){if(m===`text/plain`){let{text:e,byteLength:t}=i(p);self.postMessage({id:d,success:!0,result:e,mimeType:m,byteLength:t})}else{let e=a(p);self.postMessage({id:d,success:!0,result:e.buffer,mimeType:m,byteLength:e.byteLength,hash:n(t,e)},[e.buffer])}}else self.postMessage({id:d,success:!1,error:`Unknown action: ${f}`})}catch(e){self.postMessage({id:d,success:!1,error:e.message})}};",bt=typeof self<`u`&&self.Blob&&new Blob([`URL.revokeObjectURL(import.meta.url);`,yt],{type:`text/javascript;charset=utf-8`});function xt(e){let t;try{if(t=bt&&(self.URL||self.webkitURL).createObjectURL(bt),!t)throw``;let n=new Worker(t,{type:`module`,name:e?.name});return n.addEventListener(`error`,()=>{(self.URL||self.webkitURL).revokeObjectURL(t)}),n}catch{return new Worker(`data:text/javascript;charset=utf-8,`+encodeURIComponent(yt),{type:`module`,name:e?.name})}}var St=class{constructor(){this.worker=null,this.callbacks=new Map,this.msgId=0}init(){this.worker||(this.worker=new xt,this.worker.onmessage=e=>{let{id:t,success:n,result:r,error:i,mimeType:a,byteLength:o,hash:s}=e.data,c=this.callbacks.get(t);c&&(this.callbacks.delete(t),n?c.resolve({result:r,mimeType:a,byteLength:o,hash:s}):c.reject(Error(i)))},console.log(`Clipboard Web Worker initialized.`))}terminate(){if(!this.worker)return;this.worker.terminate(),this.worker=null;let e=Array.from(this.callbacks.values());this.callbacks.clear();for(let{reject:t}of e){let e=Error(`Worker Terminated`);e.name=`AbortError`,t(e)}console.log(`Clipboard Web Worker terminated and pending operations aborted.`)}async encodeText(e){return this.init(),new Promise((t,n)=>{let r=++this.msgId;this.callbacks.set(r,{resolve:t,reject:n}),this.worker.postMessage({id:r,action:`ENCODE_TEXT_TO_B64`,payload:e})})}async encodeBinary(e,t){return this.init(),new Promise((n,r)=>{let i=++this.msgId;this.callbacks.set(i,{resolve:n,reject:r}),this.worker.postMessage({id:i,action:`ENCODE_BINARY_TO_B64`,payload:e,hash:t},[e])})}async hashBytes(e){return this.init(),new Promise((t,n)=>{let r=++this.msgId;this.callbacks.set(r,{resolve:t,reject:n}),this.worker.postMessage({id:r,action:`HASH_BYTES`,payload:e},[e])})}async reencodePng(e){return this.init(),new Promise((t,n)=>{let r=++this.msgId;this.callbacks.set(r,{resolve:t,reject:n}),this.worker.postMessage({id:r,action:`REENCODE_PNG`,payload:e})})}async decode(e,t){return this.init(),new Promise((n,r)=>{let i=++this.msgId;this.callbacks.set(i,{resolve:n,reject:r}),this.worker.postMessage({id:i,action:`DECODE_FROM_B64`,payload:e,mimeType:t})})}decodeStream(e){this.init();let t=++this.msgId;return this.worker.postMessage({id:t,action:`DECODE_BEGIN`,mimeType:e}),{push:e=>{this.worker&&this.worker.postMessage({id:t,action:`DECODE_CHUNK`,payload:e})},finish:()=>new Promise((e,n)=>{if(!this.worker){n(Error(`Worker Terminated`));return}this.callbacks.set(t,{resolve:e,reject:n}),this.worker.postMessage({id:t,action:`DECODE_END`})}),abort:()=>{this.worker&&this.worker.postMessage({id:t,action:`DECODE_ABORT`})}}}},R=5381;async function z(e,t,n){try{let r=t.slice(),i=await e.encodeBinary(r.buffer,n);return{b64:i.result,hash:i.hash}}catch(e){console.warn(`Clipboard worker encode failed; falling back to main thread:`,e);let n=``;for(let e=0;e<t.length;e+=32768)n+=String.fromCharCode.apply(null,t.subarray(e,e+32768));return{b64:btoa(n),hash:void 0}}}async function Ct(e,t,{worker:n,send:r,waitDrain:i,chunkRawBytes:a,nextTid:o}){let s=t===`text/plain`,c=e.byteLength;if(c<a){let{b64:i,hash:a}=await z(n,e,R);return r(s?`cw,${i}`:`cb,${t},${i}`),a}let l=o();r(s?`cws,${l},${c}`:`cbs,${l},${t},${c}`);let u=R;for(let t=0;t<c;t+=a){if(i&&await i()===!1)return;let o=await z(n,e.subarray(t,t+a),u);u=o.hash,r(s?`cwd,${l},${o.b64}`:`cbd,${l},${o.b64}`)}return r(s?`cwe,${l}`:`cbe,${l}`),u}var wt={de:`de`,fr:`fr`,es:`es`,it:`it`,pt:`pt`,ru:`ru`,pl:`pl`,cs:`cz`,sk:`sk`,hu:`hu`,tr:`tr`,da:`dk`,sv:`se`,nb:`no`,nn:`no`,no:`no`,fi:`fi`,nl:`nl`,ja:`jp`,ko:`kr`,el:`gr`,he:`il`,uk:`ua`,en:`us`},B={GB:`gb`,BR:`br`,CH:`ch`,BE:`be`};function Tt(e){if(!e||typeof e!=`string`)return null;let[t,n]=e.split(`-`);if(n){let e=B[n.toUpperCase()];if(e)return e}return wt[t.toLowerCase()]||null}async function Et(){try{let e=navigator.keyboard;if(e&&typeof e.getLayoutMap==`function`){let t=await e.getLayoutMap();if(t&&t.size){let e=e=>(t.get(e)||``).toLowerCase();if(e(`KeyY`)===`z`&&e(`KeyZ`)===`y`)return e(`Minus`)===`ß`?`de`:Tt(navigator.language)||`de`;if(e(`KeyQ`)===`a`&&e(`KeyA`)===`q`)return`fr`;if(e(`Semicolon`)===`ñ`)return`es`;if(e(`Semicolon`)===`ò`)return`it`;if(e(`KeyY`)===`y`&&e(`KeyQ`)===`q`){if(e(`Backslash`)===`#`)return`gb`;if(e(`Semicolon`)===`;`)return`us`}}}}catch{}return Tt(navigator.language)}var Dt=!1;function V(){if(Dt||typeof window>`u`)return;Dt=!0;let e=window.fetch.bind(window),t=`__selkiesAuthReloadChain`,n=()=>{try{let e=JSON.parse(sessionStorage.getItem(t)||`null`);if(e)return e}catch{}try{let e=window.history.state;if(e&&typeof e==`object`&&e[t])return e[t]}catch{}return null},r=e=>{let n=!1;try{sessionStorage.setItem(t,JSON.stringify(e)),n=!0}catch{}if(!n)try{let n=window.history.state;(n==null||typeof n==`object`&&!Array.isArray(n))&&window.history.replaceState(Object.assign({},n||{},{[t]:e}),``)}catch{}},i=0,a=n();a&&Date.now()-a.at<3e4&&(i=a.n|0);let o=!1,s=!1,c=()=>{if(o||i>=2){!o&&!s&&(s=!0,console.warn(`auth-guard: 401 persists after reloads; leaving the page as-is instead of looping.`));return}o=!0,r({at:Date.now(),n:i+1}),window.location.reload()},l=e=>{try{let t=typeof e==`string`||e instanceof URL?String(e):e.url;return new URL(t,window.location.href).origin===window.location.origin}catch{return!0}},u=e=>{try{return/^Bearer realm="Selkies/i.test(e.headers.get(`WWW-Authenticate`)||``)}catch{return!1}};window.__selkiesAuthReload=c,window.fetch=async(...t)=>{let n=await e(...t);return n.status===401&&l(t[0])&&!u(n)&&c(),n},window.__selkiesAuthProbe=()=>{try{window.fetch(new Request(window.location.href,{method:`HEAD`,cache:`no-store`,credentials:`same-origin`})).catch(()=>{})}catch{}}}var H={h264enc:`crf`,h265enc:`crf`,vp8enc:`crf`,vp9enc:`crf`,av1enc:`crf`,"h264enc-striped":`crf`,jpeg:`crf`};function Ot(e,t){return e===`jpeg`?!1:e===`h264enc-striped`||!!t}function kt(e,t,n){return(e===`h264enc`||e===`h264enc-striped`)&&t&&t.h264===`openh264`&&Ot(e,n)?`cbr`:H[e]}function At({server:e,stored:t,parse:n=e=>e,conditional:r,isValid:i}){let a=e=>e!=null&&(!i||i(e));if(e&&e.locked)return e.value;if(t!=null){let e=n(t);if(a(e))return e}if(e&&e.overridden&&a(e.value))return e.value;let o=r?r():void 0;return a(o)?o:e?e.value:void 0}function jt(e,t,n,r){let i=At({server:t?t[e.serverKey]:void 0,stored:r(e.storageKey),parse:e.parse,conditional:e.conditional?()=>e.conditional(n):void 0,isValid:e.isValid?t=>e.isValid(t,n):void 0})??e.fallback;return e.toUi?e.toUi(i):i}var Mt={id:`hidpi`,serverKey:`use_css_scaling`,storageKey:`useCssScaling`,parse:e=>e===`true`,conditional:e=>e.manualActive?!0:void 0,fallback:!1,toUi:e=>!e,toServer:e=>!e,serialize:e=>String(!e),propagate:(e,t,n)=>n.postToCore({type:`setUseCssScaling`,value:e})},Nt={id:`rate_control_mode`,serverKey:`rate_control_mode`,storageKey:`rate_control_mode`,conditional:e=>e.streamMode===`webrtc`?`cbr`:kt(e.activeEncoder,e.softwareEncoders,e.useCpu),isValid:(e,t)=>t.allowedRateControl.includes(e),fallback:`crf`,propagate:(e,t,n)=>n.postSetting({rate_control_mode:e})};function Pt(e,t,n){return{id:e,serverKey:e,storageKey:e,parse:e=>e===`true`,fallback:t,propagate:n}}var Ft=Pt(`use_browser_cursors`,!1,(e,t,n)=>n.postToCore({type:`setUseBrowserCursors`,value:e})),It=Pt(`video_fullcolor`,!1,(e,t,n)=>n.postSetting({video_fullcolor:e})),Lt=Pt(`video_streaming_mode`,!1,(e,t,n)=>n.postSetting({video_streaming_mode:e})),Rt={...Pt(`use_paint_over_quality`,!0,(e,t,n)=>n.postSetting({use_paint_over_quality:e})),conditional:e=>e.rateControlMode===`cbr`?!1:e.rateControlMode===`crf`||void 0},zt=Pt(`use_cpu`,!1,(e,t,n)=>n.postSetting({use_cpu:e})),Bt=Pt(`force_aligned_resolution`,!1,(e,t,n)=>n.postSetting({force_aligned_resolution:e})),Vt={...Pt(`raw_pointer_motion`,!0,(e,t,n)=>n.postToCore({type:`setRawPointerMotion`,value:e})),conditional:e=>!e.macDesktop&&void 0},Ht=Pt(`mac_cmd_as_ctrl`,!0,(e,t,n)=>n.postToCore({type:`setMacCmdAsCtrl`,value:e})),Ut=[Mt,Nt,Ft,It,Lt,Rt,zt,Bt,Vt,Ht].reduce((e,t)=>(t.storageKey!==t.serverKey&&(e[t.serverKey]=t.storageKey),e),{});function Wt(e){return Ut[e]||e}var U=[{id:1,name:`h264`,codec:`avc1.42E01F`,extra:{avc:{format:`annexb`}}},{id:2,name:`vp8`,codec:`vp8`,extra:{}},{id:3,name:`vp9`,codec:`vp09.00.31.08`,extra:{}},{id:4,name:`av1`,codec:`av01.0.05M.08`,extra:{}},{id:5,name:`h265`,codec:`hev1.1.6.L93.B0`,extra:{hevc:{format:`annexb`}}}],Gt=4e3,Kt=2,qt=[`auto`,`h264`,`h265`,`vp8`,`vp9`,`av1`,`mjpeg`],Jt=1/6;function Yt(){let e=0,t=0;return{note(n){e++,n&&t++},tooSlow(){if(e<60)return!1;let n=t/e>Jt;return e=0,t=0,n},behindRatio(){return e?t/e:0},reset(){e=0,t=0}}}function W(e){let t=15e3/(e>0?e:30),n=[];return{budgetMs:t,sent(e,t){n.push({timestamp:e,wall:t})},answered(e){for(;n.length&&n[0].timestamp<=e;)n.shift()},lagMs(e){return n.length?e-n[0].wall:0},reset(){n=[]}}}var Xt=e=>{e&&typeof e.close==`function`&&e.close()},Zt=2,Qt=typeof VideoFrame<`u`&&typeof VideoFrame.prototype==`object`&&`rotation`in VideoFrame.prototype,$t=-90,en={rotation:0,flip:!1},tn=()=>((window.orientation-$t)%360+360)%360,nn=()=>!Qt&&typeof window.orientation==`number`,rn=`
let reader = null, track = null, inFlight = 0;
self.onmessage = async (e) => {
  const m = e.data;
  if (m.type === 'ack') { if (inFlight > 0) inFlight--; return; }
  if (m.type === 'stop') { try { reader && reader.cancel(); } catch (err) {} try { track && track.stop(); } catch (err) {} reader = null; return; }
  if (m.type !== 'source') return;
  track = m.track;
  try { reader = new MediaStreamTrackProcessor({ track }).readable.getReader(); }
  catch (err) { self.postMessage({ type: 'failed' }); return; }
  self.postMessage({ type: 'ready' });
  for (;;) {
    let r;
    try { r = await reader.read(); } catch (err) { break; }
    if (r.done) break;
    if (inFlight >= ${Zt}) { r.value.close(); continue; }
    inFlight++;
    self.postMessage({ type: 'frame', frame: r.value }, [r.value]);
  }
  self.postMessage({ type: 'end' });
};
`,an=`
let CANDIDATES = ${JSON.stringify(U)};
const PACE_MIN_SAMPLES = 60;
const PACE_BEHIND_RATIO = ${Jt};
const PACE_LAG_INTERVALS = 15;
const PROBE_COLOR_TOLERANCE = 48;
const createLagGauge = ${W.toString()};
const KEYFRAME_INTERVAL_MS = ${Gt};
const HAS_FRAME_ORIENTATION = ${Qt};
// Frames taken from the camera to measure the candidates with, how long to wait
// for them, and the time one candidate may spend on them. Synthetic content
// cannot stand in: a codec costs what the lens shows, at the size it shows it.
const PROBE_SOURCE_FRAMES = 8;
const PROBE_WAIT_MS = 2500;
const PROBE_BUDGET_MS = 400;
// Share of the asked rate a candidate must clearly reach to start on: a few
// frames either way is noise, and the watchdog judges what the camera then
// does to it on real frames.
const PROBE_RATE_MARGIN = 0.9;
let encoder = null, candIndex = 0, cand = null, configuring = false, active = true;
let wirePort = null;
// Camera frames held while probing; during the measurement itself further
// frames are dropped, so nothing reaches the wire unvetted.
let probing = false, measuring = false, probeFrames = [], probeTimer = null;
let fps = 30, bitrate = 2500000, encodedSize = null, forceKeyframe = true, lastKeyframeMs = 0;
let trackReader = null, trackRef = null;
// The pace window (see createEncodePace) and the staleness gauge that
// catches an encoder holding frames off-queue.
let paceOffered = 0, paceBehind = 0, lag = null;
// The upright transform every chunk is stamped with, and the one the encoder
// latched: they differ where the page derives what the frames do not carry, and
// then no rebuild is owed for a turn the encoder never sees.
let orientation = { rotation: 0, flip: false }, derived = null;

function encoderConfig(c, w, h) {
  return { codec: c.codec, width: w, height: h, bitrate, framerate: fps, latencyMode: 'realtime', ...c.extra };
}

async function makeEncoder(w, h, latched) {
  configuring = true;
  while (candIndex < CANDIDATES.length) {
    cand = CANDIDATES[candIndex];
    let support = null;
    try { support = await VideoEncoder.isConfigSupported(encoderConfig(cand, w, h)); } catch (err) { support = null; }
    if (!active) { configuring = false; return false; }
    if (!support || !support.supported) { candIndex++; continue; }
    try {
      const enc = new VideoEncoder({
        output: (chunk) => {
          if (lag) lag.answered(chunk.timestamp);
          if (!active) return;
          const buf = new ArrayBuffer(chunk.byteLength);
          chunk.copyTo(new Uint8Array(buf));
          const framed = { codecId: cand.id, keyframe: chunk.type === 'key', buffer: buf,
                           rotation: orientation.rotation, flip: orientation.flip };
          if (wirePort) wirePort.postMessage(framed, [buf]);
          else self.postMessage({ type: 'chunk', ...framed }, [buf]);
        },
        error: (err) => { try { encoder && encoder.close(); } catch (x) {} encoder = null; encodedSize = null; lag = null; candIndex++; },
      });
      enc.configure(support.config || encoderConfig(cand, w, h));
      encoder = enc; encodedSize = { w: w, h: h, rotation: latched.rotation, flip: latched.flip };
      lag = createLagGauge(fps);
      forceKeyframe = true; configuring = false;
      self.postMessage({ type: 'ready', codec: cand.name });
      return true;
    } catch (err) { candIndex++; }
  }
  encoder = null; encodedSize = null; configuring = false;
  self.postMessage({ type: 'unsupported' });
  return false;
}

function encodeWith(frame, w, h) {
  if (!encoder || encoder.state !== 'configured' || !active) { frame.close(); return; }
  const now = performance.now();
  // A visible queue and stale output both count as behind.
  const behind = encoder.encodeQueueSize > 1 || (lag !== null && lag.lagMs(now) > lag.budgetMs);
  paceOffered++;
  if (behind) paceBehind++;
  if (paceOffered >= PACE_MIN_SAMPLES) {
    const slow = paceBehind / paceOffered > PACE_BEHIND_RATIO;
    paceOffered = 0; paceBehind = 0;
    // Dropping or delaying this much of the camera is what a codec this
    // engine cannot encode in real time looks like: a core at full tilt and
    // a receiver falling behind. Take the next rung; the page takes the JPEG
    // one when this list runs out.
    if (slow) {
      self.postMessage({ type: 'slow', codec: cand ? cand.name : '' });
      try { if (encoder && encoder.state !== 'closed') encoder.close(); } catch (err) {}
      encoder = null; encodedSize = null; lag = null; candIndex++;
      if (candIndex >= CANDIDATES.length) self.postMessage({ type: 'exhausted' });
      frame.close();
      return;
    }
  }
  // The encoder is behind: drop this input frame (never an encoded output) so no
  // reference chain breaks; a worker rarely reaches this, which is the point.
  if (behind) { frame.close(); return; }
  const keyFrame = forceKeyframe || now - lastKeyframeMs >= KEYFRAME_INTERVAL_MS;
  try {
    encoder.encode(frame, { keyFrame: keyFrame });
    if (lag) lag.sent(frame.timestamp, now);
    if (keyFrame) { lastKeyframeMs = now; forceKeyframe = false; }
  } catch (err) { try { encoder.close(); } catch (x) {} encoder = null; encodedSize = null; lag = null; candIndex++; }
  frame.close();
}

function orientationOf(frame) {
  return HAS_FRAME_ORIENTATION
    ? { rotation: frame.rotation || 0, flip: !!frame.flip }
    : { rotation: 0, flip: false };
}

function handleFrame(frame, label) {
  if (!active) { frame.close(); return; }
  const w = frame.displayWidth || frame.codedWidth;
  const h = frame.displayHeight || frame.codedHeight;
  const latched = orientationOf(frame);
  orientation = label || (HAS_FRAME_ORIENTATION ? latched : (derived || orientation));
  if (probing) {
    if (measuring || probeFrames.length >= PROBE_SOURCE_FRAMES) { frame.close(); return; }
    // The window belongs to the camera once it is delivering. A device chosen
    // from several starts late, and a window spent waiting for it would expire
    // holding too few frames to measure anything.
    if (!probeFrames.length && probeTimer !== null) {
      clearTimeout(probeTimer);
      probeTimer = setTimeout(() => { if (probing) runProbe(w, h); }, PROBE_WAIT_MS);
    }
    probeFrames.push(frame);
    if (probeFrames.length >= PROBE_SOURCE_FRAMES) runProbe(w, h);
    return;
  }
  if (configuring) { frame.close(); return; }
  // A spent ladder was announced once; later frames are not a fresh verdict.
  if (!encoder && candIndex >= CANDIDATES.length) { frame.close(); return; }
  if (!encoder || !encodedSize || encodedSize.w !== w || encodedSize.h !== h ||
      encodedSize.rotation !== latched.rotation || encodedSize.flip !== latched.flip) {
    makeEncoder(w, h, latched).then(() => { if (encoder) encodeWith(frame, w, h); else frame.close(); });
    return;
  }
  encodeWith(frame, w, h);
}

// Frames per second one candidate sustains on the camera's own frames, or 0 if
// it cannot encode them.
async function measure(c, w, h, frames) {
  const out = { rate: 0, colErr: -1 };
  let support = null;
  try { support = await VideoEncoder.isConfigSupported(encoderConfig(c, w, h)); } catch (err) { return out; }
  if (!support || !support.supported) return out;
  let encoded = 0, failed = false;
  const chunks = [];
  const enc = new VideoEncoder({
    output: (chunk) => {
      encoded++;
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      chunks.push({ key: chunk.type === 'key', ts: chunk.timestamp, data });
    },
    error: () => { failed = true; },
  });
  try { enc.configure(support.config || encoderConfig(c, w, h)); } catch (err) { return out; }
  const started = performance.now();
  // The frames stay open: each candidate encodes the same ones, and the probe
  // closes them once the last candidate has had its turn.
  for (let i = 0; i < frames.length && !failed; i++) {
    try { enc.encode(frames[i], { keyFrame: i === 0 }); } catch (err) { failed = true; }
  }
  await Promise.race([
    enc.flush().catch(() => { failed = true; }),
    new Promise((r) => setTimeout(r, PROBE_BUDGET_MS)),
  ]);
  const rate = encoded / ((performance.now() - started) / 1000);
  try { enc.close(); } catch (err) { /* already closed */ }
  if (failed) return out;
  out.rate = rate;
  out.colErr = await colorError(frames[0], chunks, c);
  return out;
}

// Largest per-channel difference between region means of the first probe frame
// and its own decoded output, or -1 when there is nothing to judge with (an
// unjudged candidate passes). Drawn unscaled over a coarse grid: means converge
// however lossily grain encodes while false chroma moves whole regions, and
// drawImage downscaling point-samples on some engines.
async function colorError(frame, chunks, c) {
  if (typeof OffscreenCanvas === 'undefined' || typeof VideoDecoder === 'undefined' || !chunks.length) return -1;
  const cells = 4;
  const regionMeans = (source, w, h) => {
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(source, 0, 0);
    const d = ctx.getImageData(0, 0, w, h).data;
    const sums = new Float64Array(cells * cells * 3);
    const counts = new Float64Array(cells * cells);
    for (let y = 0; y < h; y++) {
      const rowCell = (((y * cells) / h) | 0) * cells;
      for (let x = 0; x < w; x++) {
        const cell = rowCell + (((x * cells) / w) | 0);
        const i = (y * w + x) * 4;
        sums[cell * 3] += d[i];
        sums[cell * 3 + 1] += d[i + 1];
        sums[cell * 3 + 2] += d[i + 2];
        counts[cell]++;
      }
    }
    for (let cell = 0; cell < counts.length; cell++) {
      sums[cell * 3] /= counts[cell];
      sums[cell * 3 + 1] /= counts[cell];
      sums[cell * 3 + 2] /= counts[cell];
    }
    return sums;
  };
  const decoded = [];
  try {
    const w = frame.displayWidth || frame.codedWidth;
    const h = frame.displayHeight || frame.codedHeight;
    const want = regionMeans(frame, w, h);
    let failed = false;
    const dec = new VideoDecoder({ output: (f) => decoded.push(f), error: () => { failed = true; } });
    dec.configure({ codec: c.codec });
    for (let i = 0; i < chunks.length; i++) {
      dec.decode(new EncodedVideoChunk({ type: chunks[i].key ? 'key' : 'delta', timestamp: chunks[i].ts, data: chunks[i].data }));
    }
    await dec.flush();
    let err = -1;
    if (decoded.length && !failed) {
      const got = regionMeans(decoded[decoded.length - 1], w, h);
      err = 0;
      for (let i = 0; i < want.length; i++) err = Math.max(err, Math.abs(want[i] - got[i]));
    }
    try { dec.close(); } catch (e2) { /* already closed */ }
    for (let i = 0; i < decoded.length; i++) { try { decoded[i].close(); } catch (e2) {} }
    return err;
  } catch (err) {
    for (let i = 0; i < decoded.length; i++) { try { decoded[i].close(); } catch (e2) {} }
    return -1;
  }
}

self.onmessage = async (e) => {
  const m = e.data;
  if (m.type === 'frame') { handleFrame(m.frame, { rotation: m.rotation, flip: m.flip }); return; }
  // The page derives what a track this worker reads cannot tell it: no window here.
  if (m.type === 'orientation') { derived = { rotation: m.rotation, flip: m.flip }; return; }
  if (m.type === 'track') {
    // Combined read+encode: read the transferred camera track in this worker, so
    // frames never reach the page thread. Needs a worker MediaStreamTrackProcessor.
    if (typeof MediaStreamTrackProcessor === 'undefined') { self.postMessage({ type: 'track_unsupported' }); return; }
    try { trackReader = new MediaStreamTrackProcessor({ track: m.track }).readable.getReader(); }
    catch (err) { self.postMessage({ type: 'track_unsupported' }); return; }
    trackRef = m.track;
    self.postMessage({ type: 'track_reading' });
    (async () => {
      for (;;) {
        let r;
        try { r = await trackReader.read(); } catch (err) { break; }
        if (r.done || !active) { if (r.value) r.value.close(); break; }
        handleFrame(r.value);
      }
    })();
    return;
  }
  if (m.type === 'keyframe') { forceKeyframe = true; return; }
  if (m.type === 'wirePort') {
    // Encoded frames then go straight to the transport; the receiver answers
    // {needKeyframe:true} when a send gap broke the delta chain.
    wirePort = m.port;
    wirePort.onmessage = (ev) => { if (ev.data && ev.data.needKeyframe) forceKeyframe = true; };
    return;
  }
  if (m.type === 'config') { if (m.fps) fps = m.fps; if (m.bitrate) bitrate = m.bitrate; return; }
  if (m.type === 'stop') {
    active = false;
    try { trackReader && trackReader.cancel(); } catch (x) {}
    try { trackRef && trackRef.stop(); } catch (x) {}
    trackReader = null; trackRef = null;
    try { encoder && encoder.close(); } catch (x) {} encoder = null;
    return;
  }
  if (m.type === 'probe') {
    fps = m.fps || 30; bitrate = m.bitrate || 2500000;
    if (Array.isArray(m.candidates) && m.candidates.length) CANDIDATES = m.candidates;
    if (typeof VideoEncoder === 'undefined') { self.postMessage({ type: 'unsupported' }); return; }
    probing = true; probeFrames = [];
    // A camera that never delivers must not hold the uplink: rank on whatever
    // arrived, and if nothing did, open on the first candidate and leave the
    // watchdog to answer for it.
    probeTimer = setTimeout(() => {
      if (probing) runProbe(m.width || 1280, m.height || 720);
    }, PROBE_WAIT_MS);
  }
};

// Ranks the candidates on the held camera frames and commits to one, or hands
// the page the JPEG rung when none of them keeps up with what the lens is
// showing at the size it is showing it.
async function runProbe(w, h) {
  if (!probing || measuring) return;
  measuring = true;
  if (probeTimer !== null) { clearTimeout(probeTimer); probeTimer = null; }
  const frames = probeFrames;
  probeFrames = [];
  // A partial set is no measurement: a few frames carry the keyframe and the
  // flush and read low enough to reject a codec that keeps up, so open on
  // the first candidate and let the watchdog answer for it.
  if (frames.length < PROBE_SOURCE_FRAMES) {
    probing = false; measuring = false;
    for (let i = 0; i < frames.length; i++) { try { frames[i].close(); } catch (err) {} }
    if (!active) return;
    self.postMessage({ type: 'probed', codec: CANDIDATES[0].name });
    return;
  }
  let best = -1, bestRate = 0, wrongColor = false;
  for (let i = 0; i < CANDIDATES.length; i++) {
    const m = await measure(CANDIDATES[i], w, h, frames);
    // Wrong colors are out however fast; the JPEG rung draws through the
    // reference's own path.
    if (m.colErr > PROBE_COLOR_TOLERANCE) {
      wrongColor = true;
      self.postMessage({ type: 'wrongcolor', codec: CANDIDATES[i].name, colErr: Math.round(m.colErr) });
      continue;
    }
    if (m.rate > bestRate) { best = i; bestRate = m.rate; }
    if (m.rate >= fps) break;
  }
  probing = false; measuring = false;
  for (let i = 0; i < frames.length; i++) { try { frames[i].close(); } catch (err) {} }
  if (!active) return;
  if (best < 0) {
    candIndex = CANDIDATES.length;
    self.postMessage({ type: wrongColor ? 'exhausted' : 'unsupported' });
    return;
  }
  // Nothing near the asked rate: starting anyway spends a core to send a
  // fraction of the camera, which the JPEG rung exists to avoid. Merely-near
  // is taken; the watchdog answers for it.
  if (bestRate < fps * PROBE_RATE_MARGIN) {
    candIndex = CANDIDATES.length;
    self.postMessage({ type: 'exhausted', codec: CANDIDATES[best].name, rate: bestRate.toFixed(1) });
    return;
  }
  candIndex = best;
  self.postMessage({ type: 'probed', codec: CANDIDATES[best].name, rate: Math.round(bestRate) });
}
`,on=class{constructor(e){this._sendFrame=e.sendFrame,this._onStateChange=e.onStateChange||(()=>{}),this._onError=e.onError||(()=>{}),this._canSend=e.canSend||(()=>!0),this.width=e.width||1280,this.height=e.height||720,this.fps=e.fps||30,this.bitrate=e.bitrate||25e5,this.quality=e.quality||.8,this.encoderPreference=qt.indexOf(e.encoderPreference)>=0?e.encoderPreference:`auto`,this._encoderCandidates=U.some(e=>e.name===this.encoderPreference)?U.filter(e=>e.name===this.encoderPreference):U,this._stream=null,this._track=null,this._source=null,this._establishing=!1,this._encoder=null,this._encoderCodec=null,this._candidateIndex=0,this._encodedSize=null,this._forceKeyframe=!0,this._chainBroken=!1,this._lastKeyframeMs=0,this._lastFrameMs=0,this._frameCredit=0,this._canvas=null,this._ctx=null,this._jpegBusy=!1,this._pace=Yt(),this._configuring=!1,this._deriveOrientation=!1,this._orientation=en,this._orientationWatch=null,this._active=!1,this._generation=0,this._encodeWorker=null,this._wireProvider=null,this._workerTrackUnsupported=!1,this._settleEncodeWorker=null,this._workerIsSource=!1,this._encoderCodecName=null}get active(){return this._active}get codec(){return this._encoderCodecName?this._encoderCodecName:this._encoderCodec?this._encoderCodec.name:this._active?`mjpeg`:null}_logPath(e){this._loggedPaths||=new Set,!this._loggedPaths.has(e)&&(this._loggedPaths.add(e),console.info(`[Webcam] ${e}`))}async start(e){if(this._active)return;if(!navigator.mediaDevices||!navigator.mediaDevices.getUserMedia){let e=Error(`getUserMedia unavailable`);e.name=`NotSupportedError`,this._onError(e);return}let t={width:{ideal:this.width},height:{ideal:this.height},frameRate:{ideal:this.fps}};e&&(t.deviceId={exact:e});let n;try{n=await navigator.mediaDevices.getUserMedia({video:t,audio:!1})}catch(e){this._onError(e);return}let r=n.getVideoTracks()[0];if(!r){n.getTracks().forEach(e=>e.stop()),this._onError(Error(`no video track`));return}this._stream=n,this._track=r,this._active=!0,this._forceKeyframe=!0,this._chainBroken=!1,this._lastFrameMs=0,this._frameCredit=0;let i=++this._generation;if(r.addEventListener(`ended`,()=>{this._generation===i&&this.stop()}),this._onStateChange(!0),this._source=await this._openCapture(r,i),this._generation!==i){this._source&&this._source.close();return}this._source||(this._onError(Error(`no frame source for the camera track`)),this.stop())}requestKeyframe(){if(this._forceKeyframe=!0,this._encodeWorker)try{this._encodeWorker.postMessage({type:`keyframe`})}catch{}}stop(){if(this._active||this._stream){if(this._generation++,this._active=!1,this._stopEncodeWorker(),this._source&&=(this._source.close(),null),this._encoder){try{this._encoder.close()}catch{}this._encoder=null,this._encoderCodec=null}this._configuring=!1,this._deriveOrientation=!1,this._orientation=en,this._unwatchOrientation(),this._stream&&(this._stream.getTracks().forEach(e=>{try{e.stop()}catch{}}),this._stream=null,this._track=null),this._canvas=null,this._ctx=null,this._encodedSize=null,this._candidateIndex=0,this._encoderCodecName=null,this._chainBroken=!1,this._lastFrameMs=0,this._frameCredit=0,this._onStateChange(!1)}}async _openCapture(e,t){this._establishing=!0,this.encoderPreference===`mjpeg`&&(this._candidateIndex=this._encoderCandidates.length,this._encoderCodecName=`mjpeg`,this._logPath(`encode: JPEG (webcam_encoder is mjpeg)`));let n=this._openEncodeWorker(t);try{let r=null,i=!1;return this._encodeWorker&&(r=await this._tryCombinedWorker(e,t),i=!!r,this._generation!==t)||(r||=await this._openSource(e,t),this._generation!==t)||(await n,this._generation!==t)||i&&!this._encodeWorker&&(r=await this._openSource(e,t),this._generation!==t)?(r&&r.close(),null):r}finally{this._establishing=!1}}_tryCombinedWorker(e,t){let n=this._encodeWorker;if(!n)return Promise.resolve(null);let r;try{r=e.clone()}catch{return Promise.resolve(null)}return new Promise(e=>{let t=!1,i=r=>{t||(t=!0,n.removeEventListener(`message`,a),clearTimeout(o),e(r))},a=e=>{let t=e.data;if(t.type===`track_reading`)this._workerIsSource=!0,this._deriveOrientation=nn(),this._watchOrientation(),this._logPath(`capture+encode: camera read and encoded in a worker`),i({close:()=>this._stopEncodeWorker()});else if(t.type===`track_unsupported`){this._workerTrackUnsupported=!0;try{r.stop()}catch{}i(null)}},o=setTimeout(()=>{try{r.stop()}catch{}i(null)},2e3);n.addEventListener(`message`,a);try{n.postMessage({type:`track`,track:r},[r])}catch{try{r.stop()}catch{}i(null)}})}setWireProvider(e){this._wireProvider=e}_openEncodeWorker(e){if(typeof VideoEncoder>`u`||typeof Worker>`u`||this._candidateIndex>=this._encoderCandidates.length)return Promise.resolve();let t;try{let e=URL.createObjectURL(new Blob([an],{type:`text/javascript`}));t=new Worker(e),URL.revokeObjectURL(e)}catch{return Promise.resolve()}return new Promise(n=>{let r=!1,i=()=>{r||(r=!0,this._settleEncodeWorker===a&&(this._settleEncodeWorker=null),n())},a=()=>{clearTimeout(s),i()},o=n=>{console.warn(`[Webcam] encode-worker unavailable, encoding on the page:`,n);let r=this._workerIsSource;this._encodeWorker===t&&(this._encodeWorker=null),this._workerIsSource=!1;try{t.terminate()}catch{}i(),r&&!this._establishing&&this._active&&this._generation===e&&(this._source=null,this._openSource(this._track,e).then(t=>{if(this._generation!==e){t&&t.close();return}this._source=t,t||this._onError(Error(`no frame source for the camera track`))}))},s=setTimeout(()=>o(`probe timeout`),8e3);t.onmessage=n=>{let r=n.data;if(r.type===`probed`){if(clearTimeout(s),this._encodeWorker=t,this._wireProvider)try{let e=this._wireProvider();e&&t.postMessage({type:`wirePort`,port:e},[e])}catch{}this._encoderCodecName=r.codec,this._logPath(r.rate===void 0?`encode: ${r.codec} in a worker, unmeasured (no camera frames to rank on)`:`encode: ${r.codec} in a worker, ${r.rate} fps measured against ${this.fps} asked for`),i();return}if(r.type===`ready`){this._encoderCodecName=r.codec;return}if(r.type===`chunk`){this._active&&this._generation===e&&this._deliverEncoded(r.codecId,r.keyframe,new Uint8Array(r.buffer),r.rotation,r.flip);return}if(r.type===`slow`){this._logPath(`encode: ${r.codec} could not keep up with the camera; taking the next rung`);return}if(r.type===`wrongcolor`){this._logPath(`encode: ${r.codec} decodes to the wrong colors on this engine (mean channel error ${r.colErr}); skipping it`);return}if(r.type===`exhausted`){clearTimeout(s),this._logPath(r.rate===void 0?`encode: no codec kept up with the camera; encoding JPEG instead`:`encode: no codec kept up with the camera (${r.codec} reached ${r.rate} fps against ${this.fps} asked for); encoding JPEG instead`),this._stopEncodeWorker(),this._candidateIndex=this._encoderCandidates.length,this._encoderCodecName=`mjpeg`,i();return}(r.type===`unsupported`||r.type===`error`)&&(clearTimeout(s),o(r.type))},t.onerror=e=>{clearTimeout(s),o(`worker.onerror: `+(e&&e.message))},this._encodeWorker=t,this._settleEncodeWorker=a;try{t.postMessage({type:`probe`,width:this.width,height:this.height,fps:this.fps,bitrate:this.bitrate,candidates:this._encoderCandidates})}catch(e){clearTimeout(s),o(`probe postMessage threw: `+e)}})}_watchOrientation(){if(!this._deriveOrientation||this._orientationWatch)return;let e=()=>this._pushOrientation();this._orientationWatch=e,window.addEventListener(`orientationchange`,e),screen.orientation&&screen.orientation.addEventListener&&screen.orientation.addEventListener(`change`,e),e()}_unwatchOrientation(){let e=this._orientationWatch;this._orientationWatch=null,e&&(window.removeEventListener(`orientationchange`,e),screen.orientation&&screen.orientation.removeEventListener&&screen.orientation.removeEventListener(`change`,e))}_pushOrientation(){if(this._encodeWorker){this._orientation={rotation:tn(),flip:!1};try{this._encodeWorker.postMessage({type:`orientation`,...this._orientation})}catch{}}}_stopEncodeWorker(){let e=this._encodeWorker,t=this._settleEncodeWorker;if(this._encodeWorker=null,this._settleEncodeWorker=null,this._workerIsSource=!1,e){e.onmessage=null;try{e.postMessage({type:`stop`})}catch{}setTimeout(()=>{try{e.terminate()}catch{}},100)}t&&t()}async _openSource(e,t){if(!this._workerTrackUnsupported){let n=await this._workerSource(e,t);if(n)return this._deriveOrientation=nn(),this._logPath(`capture: MediaStreamTrackProcessor in a worker`),n;if(this._generation!==t)return null}if(typeof MediaStreamTrackProcessor<`u`)try{let n=new MediaStreamTrackProcessor({track:e});return this._logPath(`capture: MediaStreamTrackProcessor on the page`),this._readerSource(n.readable.getReader(),t)}catch{}return typeof VideoFrame>`u`?this._pinJpegRung(`no VideoFrame constructor`):this.encoderPreference===`auto`||this.encoderPreference===`mjpeg`?this._pinJpegRung(`webcam_encoder is ${this.encoderPreference}`):this._logPath(`capture: <video> element sampled with requestVideoFrameCallback`),this._videoSource(e,t)}_pinJpegRung(e){this._stopEncodeWorker(),this._candidateIndex=this._encoderCandidates.length,this._encoderCodecName=`mjpeg`,this._logPath(`capture: <video> element sampled with requestVideoFrameCallback (JPEG: ${e})`)}_readerSource(e,t){return(async()=>{for(;;){let n;try{n=await e.read()}catch{break}if(n.done||this._generation!==t){n.value&&n.value.close();break}this._handleFrame(n.value)}})(),{close:()=>{try{e.cancel()}catch{}}}}_workerSource(e,t){return new Promise(n=>{let r;try{r=e.clone()}catch{n(null);return}let i;try{let e=URL.createObjectURL(new Blob([rn],{type:`text/javascript`}));i=new Worker(e),URL.revokeObjectURL(e)}catch{try{r.stop()}catch{}n(null);return}let a=!1,o=e=>{a||(a=!0,n(e))},s=setTimeout(()=>{i.terminate();try{r.stop()}catch{}o(null)},3e3),c={close:()=>{try{i.postMessage({type:`stop`})}catch{}setTimeout(()=>i.terminate(),100)}};i.onerror=()=>{clearTimeout(s),i.terminate();try{r.stop()}catch{}o(null)},i.onmessage=e=>{let n=e.data;if(n){if(n.type===`ready`)clearTimeout(s),o(c);else if(n.type===`failed`){clearTimeout(s),i.terminate();try{r.stop()}catch{}o(null)}else if(n.type===`frame`){if(i.postMessage({type:`ack`}),this._generation!==t){n.frame.close();return}this._handleFrame(n.frame)}else n.type===`end`&&i.terminate()}};try{i.postMessage({type:`source`,track:r},[r])}catch{clearTimeout(s),i.terminate();try{r.stop()}catch{}o(null)}})}_videoSource(e,t){let n=document.createElement(`video`);n.muted=!0,n.playsInline=!0,n.autoplay=!0,n.style.cssText=`position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;pointer-events:none;`,document.body.appendChild(n),n.srcObject=new MediaStream([e]);let r=null,i=null,a=null,o=null,s=0,c=()=>{let e=Math.round(performance.now()*1e3);try{return new VideoFrame(n,{timestamp:e})}catch{}try{return a||(a=document.createElement(`canvas`),o=a.getContext(`2d`,{alpha:!1,desynchronized:!0})),(a.width!==n.videoWidth||a.height!==n.videoHeight)&&(a.width=n.videoWidth,a.height=n.videoHeight),o.drawImage(n,0,0),new VideoFrame(a,{timestamp:e})}catch{return null}},l=()=>{if(this._generation===t){if(n.readyState>=2&&n.videoWidth>0){if(typeof VideoFrame<`u`&&this._candidateIndex<this._encoderCandidates.length){let e=c();e?(s=0,this._handleFrame(e)):++s>this.fps&&this._pinJpegRung(`VideoFrames cannot be built from the element`)}else this._handleFrame(n)}n.requestVideoFrameCallback&&(r=n.requestVideoFrameCallback(l))}},u=n.play();return u&&u.catch&&u.catch(()=>{}),n.requestVideoFrameCallback?r=n.requestVideoFrameCallback(l):i=setInterval(l,1e3/this.fps),{close:()=>{if(r!==null&&n.cancelVideoFrameCallback)try{n.cancelVideoFrameCallback(r)}catch{}i!==null&&clearInterval(i);try{n.srcObject=null}catch{}n.remove()}}}_handleFrame(e){if(!this._active||!this._canSend()){Xt(e);return}let t=performance.now();if(!this._admit(t)){Xt(e);return}if(this._encodeWorker)try{let t=this._frameOrientation(e);this._encodeWorker.postMessage({type:`frame`,frame:e,...t},[e]);return}catch{this._stopEncodeWorker(),Xt(e);return}if(typeof VideoEncoder>`u`||this._candidateIndex>=this._encoderCandidates.length){this._encodeJpeg(e,t);return}let n=e.displayWidth||e.codedWidth,r=e.displayHeight||e.codedHeight,i={rotation:e.rotation||0,flip:!!e.flip};this._orientation=this._frameOrientation(e);let a=this._encodedSize;if(!this._encoder||!a||a.w!==n||a.h!==r||a.rotation!==i.rotation||a.flip!==i.flip){if(this._configuring){e.close();return}this._configuring=!0,this._configureEncoder(n,r,i.rotation,i.flip).then(()=>this._encodeWith(e,n,r,t)).finally(()=>{this._configuring=!1});return}this._encodeWith(e,n,r,t)}_admit(e){let t=1e3/this.fps,n=this._lastFrameMs?e-this._lastFrameMs:t;return this._lastFrameMs=e,this._frameCredit=Math.min(this._frameCredit+n,t*Kt),this._frameCredit<t?!1:(this._frameCredit-=t,!0)}_frameOrientation(e){return this._deriveOrientation?{rotation:tn(),flip:!1}:{rotation:e.rotation||0,flip:!!e.flip}}_encodeWith(e,t,n,r){let i=this._encoder;if(!i||i.state!==`configured`||!this._active){e.close();return}let a=i.encodeQueueSize>1;if(this._pace.note(a),this._pace.tooSlow()){this._onEncoderTooSlow(),e.close();return}if(a){e.close();return}let o=this._forceKeyframe||r-this._lastKeyframeMs>=Gt;try{i.encode(e,{keyFrame:o}),o&&(this._lastKeyframeMs=r,this._forceKeyframe=!1)}catch(e){this._onEncoderFailure(e)}e.close()}async _configureEncoder(e,t,n=0,r=!1){let i=this._generation;if(this._encoder){try{this._encoder.close()}catch{}this._encoder=null,this._encoderCodec=null}for(;this._candidateIndex<this._encoderCandidates.length;){let a=this._encoderCandidates[this._candidateIndex],o={codec:a.codec,width:e,height:t,bitrate:this.bitrate,framerate:this.fps,latencyMode:`realtime`,...a.extra},s=null;try{s=await VideoEncoder.isConfigSupported(o)}catch{s=null}if(this._generation!==i)return;if(!s||!s.supported){this._candidateIndex++;continue}try{let c=new VideoEncoder({output:e=>this._onChunk(a,e,i),error:e=>this._onEncoderFailure(e)});c.configure(s.config||o),this._encoder=c,this._encoderCodec=a,this._encodedSize={w:e,h:t,rotation:n,flip:r},this._forceKeyframe=!0,this._logPath(`encoder: ${a.name} (${a.codec}) at ${e}x${t}`);return}catch{this._candidateIndex++}}this._encodedSize=null}_deliverEncoded(e,t,n,r,i){if(!this._canSend()){this._chainBroken=!0;return}if(this._chainBroken&&!t){this.requestKeyframe();return}this._sendFrame(e,t,n,r,i),t&&(this._chainBroken=!1)}_onChunk(e,t,n){if(this._generation!==n||!this._active)return;let r=new Uint8Array(t.byteLength);t.copyTo(r),this._deliverEncoded(e.id,t.type===`key`,r,this._orientation.rotation,this._orientation.flip)}_onEncoderTooSlow(){let e=this._encoderCodec?this._encoderCodec.name:`the encoder`;if(this._encoder){try{this._encoder.close()}catch{}this._encoder=null,this._encoderCodec=null}this._candidateIndex++,this._encodedSize=null,this._pace.reset(),this._logPath(this._candidateIndex>=this._encoderCandidates.length?`encode: ${e} could not keep up with the camera; encoding JPEG instead`:`encode: ${e} could not keep up with the camera; taking the next rung`)}_onEncoderFailure(e){if(console.warn(`Webcam encoder failed, trying the next codec:`,e),this._encoder){try{this._encoder.close()}catch{}this._encoder=null,this._encoderCodec=null}this._candidateIndex++,this._encodedSize=null}_encodeJpeg(e,t){if(this._jpegBusy){Xt(e);return}let n=this._deriveOrientation?tn():0,r=n%180==90,i=e.displayWidth||e.codedWidth||e.videoWidth,a=e.displayHeight||e.codedHeight||e.videoHeight,o=r?a:i,s=r?i:a;this._canvas?(this._canvas.width!==o||this._canvas.height!==s)&&(this._canvas.width=o,this._canvas.height=s):(this._logPath(`encoder: JPEG through OffscreenCanvas`),this._canvas=new OffscreenCanvas(o,s),this._ctx=this._canvas.getContext(`2d`,{alpha:!1,desynchronized:!0}));try{n?(this._ctx.save(),this._ctx.translate(o/2,s/2),this._ctx.rotate(n*Math.PI/180),this._ctx.drawImage(e,-i/2,-a/2,i,a),this._ctx.restore()):this._ctx.drawImage(e,0,0,o,s)}catch{Xt(e);return}Xt(e),this._jpegBusy=!0;let c=this._generation;this._canvas.convertToBlob({type:`image/jpeg`,quality:this.quality}).then(e=>e.arrayBuffer()).then(e=>{this._active&&this._generation===c&&this._sendFrame(0,!0,new Uint8Array(e))}).catch(e=>this._onError(e)).finally(()=>{this._jpegBusy=!1})}};function sn(e){if(ve){window.open(e,`_blank`);return}let t=document.createElement(`iframe`);t.style.cssText=`position:fixed;right:0;bottom:0;width:0;height:0;border:0`,t.addEventListener(`load`,()=>{let n=t.contentWindow;n.addEventListener(`afterprint`,()=>t.remove(),{once:!0});try{n.focus(),n.print()}catch{t.remove(),window.open(e,`_blank`)}}),t.src=e,document.body.appendChild(t)}function cn({automatic:e}){let t=!!e;return{async announce(e,n){let r=new URL(`api/print/`+encodeURIComponent(e),window.location.href).href,i;try{let e=await fetch(r,{headers:ht(),credentials:`same-origin`});if(!e.ok)throw Error(`HTTP ${e.status}`);i=await e.blob()}catch(t){console.warn(`Printed document ${e} (${n} bytes) was not fetched: ${t.message}`);return}let a=URL.createObjectURL(new Blob([i],{type:`application/pdf`}));window.postMessage({type:`printDocument`,name:e,size:i.size,url:a},window.location.origin),t&&!ve&&sn(a)},setAutomatic(e){t=!!e}}}function ln(e){return e===void 0?`unknown`:e===null||e===`NV12`?`hardware`:/^I4/.test(e)?`software`:`unknown`}function un({forcedSoftware:e,hardwareSupported:t,format:n}){if(e)return{decoder:`software`,decoder_evidence:`prefer-software after a decoder fallback`};if(t===!1)return{decoder:`software`,decoder_evidence:`no hardware decoder for this stream`};let r=ln(n);return r===`unknown`?{decoder:`unknown`,decoder_evidence:n?`${n} frames`:``}:{decoder:r,decoder_evidence:`${n===null?`opaque`:n} frames`}}function dn({implementation:e,powerEfficient:t,capable:n}){let r=e&&e!==`unknown`?e:``;return typeof t==`boolean`?{decoder:t?`hardware`:`software`,decoder_evidence:r}:r?{decoder:/libvpx|ffmpeg|dav1d|openh264|libaom/i.test(r)?`software`:`hardware`,decoder_evidence:r}:n===!0?{decoder:`unknown`,decoder_evidence:`a hardware decoder is available`}:n===!1?{decoder:`software`,decoder_evidence:`no hardware decoder for this stream`}:{decoder:`unknown`,decoder_evidence:``}}var fn=class{constructor({transport:e,send:t,isViewer:n,onOpenChange:r}){this._send=t,this._isViewer=n,this._onOpenChange=r||(()=>{}),this._open=!1,this._subscribed=!1,this._server={},this._serverAt=0,this._bytes=0,this._bytesAt=performance.now(),this._client={transport:e,decoder:`unknown`,decoder_evidence:``,codec:``,resolution:``,path:``,sink:``,decode_path:``},window.stream_info=null,window.stream_client=this._client,window.stream_stats={open:!1,latest:null,history:[]}}get open(){return this._open}setOpen(e){e=!!e,e!==this._open&&(this._open=e,this._bytes=0,this._bytesAt=performance.now(),window.stream_stats={open:e,latest:null,history:[]},this.subscribe(),this._onOpenChange(e))}subscribe(){let e=this._open&&!this._isViewer();if(e||this._subscribed){this._subscribed=e;try{this._send(`_stats,${+!!e}`)}catch{this._subscribed=!1}}}disconnected(){this._subscribed=!1}setInfo(e){window.stream_info=e||null}setClient(e){Object.assign(this._client,e)}serverSample(e){this._server=e||{},this._serverAt=performance.now()}noteBytes(e){this._bytes+=e}clientSample(e){if(!this._open)return;let t=performance.now(),n=(t-this._bytesAt)/1e3,r=t-this._serverAt<=3e3?this._server:{},i=Object.assign({t:Date.now()},r,e);i.mbps===void 0&&n>0&&(i.mbps=Math.round(this._bytes*8/1e6/n*100)/100),this._bytes=0,this._bytesAt=t;let a=window.stream_stats;a.latest=i,a.history.push(i),a.history.length>600&&a.history.shift()}};V(),gt();var pn=null,mn=!1,hn=null;Et().then(e=>{if(pn=e,e&&mn&&hn)try{hn.sendDataChannelMessage(`SETTINGS,${JSON.stringify({keyboardLayout:e})}`)}catch{}});var gn=0,_n=!0;function vn(){let e=document.createElement(`style`);e.textContent=`
	body {
		background-color: #000000;
		font-family: sans-serif;
		margin: 0;
		padding: 0;
		overflow: hidden;
		background-color: #000;
		color: #fff;
	}

	#app {
		display: flex;
		flex-direction: column;
		height: calc(var(--vh, 1vh) * 100);
		width: 100%;
	}

	.video-container {
		flex-grow: 1;
		flex-shrink: 1;
		display: flex;
		flex-direction: column;
		justify-content: center;
		align-items: center;
		height: 100%;
		width: 100%;
		position: relative;
		overflow: hidden;
	}

	.video-container video,
	.video-container #overlayInput{
		position: absolute;
		top: 0;
		left: 0;
		width: 100%;
		height: 100%;
	}

	.video-container video {
		max-width: 100%;
		max-height: 100%;
		object-fit: contain;
	}

	.video-container #overlayInput {
		opacity: 0;
		z-index: 3;
		caret-color: transparent;
		background-color: transparent;
		color: transparent;
		pointer-events: auto;
		-webkit-user-select: none;
		border: none;
		outline: none;
		padding: 0;
		margin: 0;
	}

	.video-container #playButton {
		position: absolute;
		top: 50%;
		left: 50%;
		transform: translate(-50%, -50%);
		z-index: 10;
	}

	.video-container .status-bar {
		position: absolute;
		bottom: 0;
		left: 0;
		width: 100%;
		padding: 5px;
		background-color: rgba(0, 0, 0, 0.7);
		color: #fff;
		text-align: center;
		z-index: 5;
	}

	.loading-text {
		margin-top: 1em;
	}

	.hidden {
		display: none !important;
	}

	#playButton {
		padding: 15px 30px;
		font-size: 1.5em;
		cursor: pointer;
		background-color: rgba(0, 0, 0, 0.5);
		color: white;
		border: 1px solid rgba(255, 255, 255, 0.3);
		border-radius: 3px;
		backdrop-filter: blur(5px);
	`,document.head.appendChild(e)}function yn(){let e,t=23,n=8e3,r=60,o=128e3,s=!1,c=!1,l=!1,u=(e,t)=>{e.push(t),e.length>1e3&&e.shift()},d=[],f=[];window.selkiesLogs={log:d,debug:f};let p=`connecting`,m=`disabled`,h=!0,ee=!0,te=!0,g=[],ne=``,re=`cbr`,ie={gamepadState:`disconnected`,gamepadName:`none`},_={connectionStatType:`unknown`,connectionLatency:0,connectionVideoLatency:0,connectionAudioLatency:0,connectionAudioCodecName:`NA`,connectionAudioBitrate:0,connectionPacketsReceived:0,connectionPacketsLost:0,connectionBytesReceived:0,connectionBytesSent:0,connectionCodec:`unknown`,connectionVideoDecoder:`unknown`,connectionResolution:``,connectionFrameRate:0,connectionVideoBitrate:0,connectionAvailableBandwidth:0};var v=null;let y=!1;var b=null;let x=null,S=null,oe=null,se=0,ce=!1,le=!1,ue=!1,de=!1,C=null,w=null,me=null,ve=500,be=!1,T,E=0;window.manualResolution=!1,window.fps=0,window.currentAudioBufferSize=0;let D=!1;var xe=``,Se=!1,O=null;let Ce=null,we={key:``,efficient:null},Te=new fn({transport:`webrtc`,send:e=>{let t=O&&O._send_channel;if(!t||t.readyState!==`open`)throw Error(`not connected`);O.sendDataChannelMessage(e)},isViewer:()=>B,onOpenChange:()=>{Ce=null}});var k=null;let Ee=null,De=null,Oe=!1,ke=96,A=!0,Ae=!0,j=new Set,je=!1,Me=!1,Ne=!1,M=!1,Pe=!1,Fe=!1,Ie=`auto`,N=!0,Le=()=>{let e=O!==void 0&&O&&O.peerConnection&&O.peerConnection.sctp&&O.peerConnection.sctp.maxMessageSize||0;return(e>0?Math.min(e,1048576):262144)-512},P=`controller`,F=`viewer`,I=null,ze=0,Ue=null,L=null,We=!0,Ze=!1,$e=!0,nt=!0,rt=!1,ot=!1,lt=!0,pt=new St,mt=it(e=>pt.decodeStream(e)),gt=at(),_t=()=>gt.arm(),yt=()=>gt.consume(),bt=e=>pt.reencodePng(e).then(e=>e.result).catch(()=>Ye(e)),xt=(()=>{let e=/iPad|iPhone|iPod/.test(navigator.userAgent)||navigator.platform===`MacIntel`&&navigator.maxTouchPoints>1,t=/Firefox|FxiOS/.test(navigator.userAgent),n=/CriOS/.test(navigator.userAgent);return((navigator.userAgentData&&navigator.userAgentData.brands||[]).some(e=>/Chromium|Google Chrome/.test(e.brand))||window.chrome!==void 0)&&!e&&!t&&!n})(),R=dt({isChromium:xt,canRead:()=>!!h,sendRequest:()=>O.sendDataChannelMessage(`REQUEST_CLIPBOARD`),digestBytes:async e=>{let{byteLength:t,hash:n}=await pt.hashBytes(e);return Je(t,n)}}),z=ct(),wt=window.location.hash;if(wt===`#shared`)Ue=F,L=-1,I=`shared`,ze=void 0;else if(wt.startsWith(`#player`)){Ue=F;let e=parseInt(wt.substring(7),10);L=e||null,e>=2&&e<=4&&(I=`player${e}`,ze=e-1)}else Ue=P,L=1,ze=0;let B=I!==null,Tt=I===`shared`,Et=!1,Dt=ge(),V=(e,t)=>{try{window.localStorage.setItem(e,t)}catch(t){console.warn(`Selkies: could not persist '${e}' to localStorage:`,t)}},H=window.location.hash.startsWith(`#display2`)?`display2`:`primary`,Ot=null,kt=!1;function At(){return He({useCssScaling:Oe,localScale:ke/96,manual:window.manualResolution,displayId:H,layouts:Ot,shared:B,wayland:kt})}let Nt=0,Pt=0,Ft=0;function It(){let e=At();k&&k.setStreamDensity&&k.setStreamDensity(e);let t=Nt>0&&Math.abs(e-Nt)>1e-6;Nt=e,t&&H!==`primary`&&!window.manualResolution&&(console.log(`Stream density changed: ${e}.`),Qn())}let Lt=[`framerate`,`video_crf`,`video_fullcolor`,`video_streaming_mode`,`use_cpu`,`video_paintover_crf`,`video_paintover_burst_frames`,`use_paint_over_quality`,`manual_resolution`,`manual_width`,`manual_height`,`encoder`,`scaleLocallyManual`,`use_browser_cursors`,`rate_control_mode`,`video_bitrate`,`force_aligned_resolution`,`scaling_dpi`],Rt=e=>{let t=`${Dt}_${e}`;return H===`display2`&&Lt.includes(e)?`${t}_${H}`:t},zt=(e,t)=>{let n=Rt(e),r=window.localStorage.getItem(n);return r==null?t:parseInt(r)},Bt=(e,t)=>{let n=Rt(e),r=window.localStorage.getItem(n),i=parseFloat(r);return r==null||isNaN(i)?t:i},Ut=(e,t)=>{let n=Rt(e);t==null?window.localStorage.removeItem(n):V(n,t.toString())},U=(e,t)=>{let n=Rt(e),r=window.localStorage.getItem(n);return r===null?t:r.toString().toLowerCase()===`true`},Gt=(e,t)=>{let n=Rt(e);t==null?window.localStorage.removeItem(n):V(n,t.toString())},Kt=(e,t)=>{let n=Rt(e);return window.localStorage.getItem(n)??t},Jt=(e,t)=>{let n=Rt(e);t==null?window.localStorage.removeItem(n):V(n,t.toString())};var Yt=e=>{var t=new Date;return`[`+(t.getHours()+`:`+t.getMinutes()+`:`+t.getSeconds())+`] `+e};let W=e=>{let t=ot?16:2;return Math.floor(e/t)*t};function Xt(){let e=$e,t=window.location.hash.startsWith(`#display2`)||rt,n=t?!0:e;k&&typeof k.setUseBrowserCursors==`function`&&(console.log(`Applying effective cursor setting. Multi-monitor: ${t}, User Pref: ${e}, Final: ${n}`),k.setUseBrowserCursors(n));try{window.postMessage({type:`effectiveCursorState`,value:n},window.location.origin)}catch{}}function Zt(){k&&typeof k.setRawPointerMotion==`function`&&k.setRawPointerMotion(nt)}let Qt=!0;function $t(){k&&typeof k.setMacCmdAsCtrl==`function`&&k.setMacCmdAsCtrl(Qt)}let en=!0,tn=null;function nn(){k&&typeof k.setShortcutsEnabled==`function`&&k.setShortcutsEnabled(en)}function rn(e){return jt(Vt,e,{macDesktop:_e()},e=>Kt(e,null))}function an(e){return jt(Ht,e,{macDesktop:_e()},e=>Kt(e,null))}function on(e){let t=Rt(`useCssScaling`),n=window.localStorage.getItem(`${t}_explicit_choice`)===`true`,r=jt(Mt,e,{manualActive:!!window.manual_resolution||window.manual_width>0},()=>n?window.localStorage.getItem(t):null);return Mt.toServer(r)}function ln(){s=!1,C&&C.classList.add(`hidden`),O.playStream(),un()}let un=async()=>{if(x===null){if(`wakeLock`in navigator)try{x=await navigator.wakeLock.request(`screen`),x.addEventListener(`release`,()=>{console.log(`Screen Wake Lock was released automatically.`),x=null}),console.log(`Screen Wake Lock is active.`)}catch(e){console.warn(`Could not acquire Wake Lock: ${e.name}, ${e.message}`)}else console.warn(`Wake Lock API is not supported by this browser.`)}},yn=async()=>{x!==null&&(await x.release(),x=null)},bn=null,xn=!1,Sn=null,Cn=0;function wn(){Sn!==null&&(clearTimeout(Sn),Sn=null),Cn=0}function Tn(){Sn!==null&&clearTimeout(Sn);let e=v?v.currentTime:0;Sn=setTimeout(()=>En(e),3e3)}function En(e){if(Sn=null,document.hidden||!O||kn){Cn=0;return}if(v&&v.currentTime>e){Cn=0;return}if(v&&v.paused&&v.play().catch(()=>{}),Cn++,Cn<=3){console.warn(`No video after resuming; resend attempt ${Cn}/3.`);try{O.sendDataChannelMessage(`START_VIDEO`)}catch{}Tn();return}Cn=0,!y&&(typeof window<`u`&&window.__selkiesModeSwitching||(console.warn(`[webrtc] no video after resuming; reloading to reconnect.`),location.reload()))}async function Dn(){if(document.hidden){wn(),bn===null&&(bn=setTimeout(()=>{if(bn=null,document.hidden&&!xn&&O&&A){xn=!0;try{O.sendDataChannelMessage(`STOP_VIDEO`)}catch{}console.log(`Tab hidden: sent STOP_VIDEO to pause this peer's feed.`)}},250));return}if(bn!==null&&(clearTimeout(bn),bn=null),xn){if(xn=!1,O)try{O.sendDataChannelMessage(`START_VIDEO`)}catch{}console.log(`Tab visible: sent START_VIDEO to resume this peer's feed.`),Tn()}else v&&v.paused&&v.play().catch(()=>{});x===null&&await un()}async function On(){if(S&&v){if(!(`setSinkId`in HTMLMediaElement.prototype)||typeof v.setSinkId!=`function`){console.warn(`setSinkId not supported; cannot select audio output device.`);return}try{await v.setSinkId(S),console.log(`Playback output set to device: ${S}`)}catch(e){console.error(`Failed to set audio output device: ${e.name}, ${e.message}`)}}}let kn=!1;function An(){w&&!kn&&(w.textContent=p&&p.charAt(0).toUpperCase()+p.slice(1),p==`connected`&&(w.classList.add(`hidden`),C&&s&&C.classList.remove(`hidden`)))}function jn(){if(v){if(!We){v.style.imageRendering!==`pixelated`&&(v.style.imageRendering=`pixelated`);return}Math.abs(At()-(window.devicePixelRatio||1))<1e-6?v.style.imageRendering!==`pixelated`&&(console.log(`Setting video rendering to 'pixelated' for sharp display.`),v.style.imageRendering=`pixelated`):v.style.imageRendering!==`auto`&&(console.log(`Setting video rendering to 'auto' for smooth upscaling.`),v.style.imageRendering=`auto`)}}function Mn(e){console.log(`Sanitizing and storing settings based on server payload.`);let t={};for(let n in e){if(!e.hasOwnProperty(n))continue;let r=e[n],i=Wt(n),a=Rt(i),o=window.localStorage.getItem(a)===null;if(r.min!==void 0&&r.max!==void 0){let e=Bt(i,r.default);o?window[n]=e:e<r.min||e>r.max?(console.log(`Sanitizing '${n}': stored value ${e} out of range [${r.min}-${r.max}]. Reverting to server default ${r.default}.`),window.localStorage.removeItem(a),window[n]=r.default,t[n]=r.default):window[n]=e}else if(r.allowed!==void 0){let e=!isNaN(parseFloat(r.allowed[0])),s=e?zt(i,parseInt(r.value,10)).toString():Kt(i,r.value),c=t=>{window[n]=e?parseInt(t,10):t};o?c(r.value):r.allowed.includes(s)?(c(s),e?Ut(i,parseInt(s,10)):Jt(i,s)):(console.log(`Sanitizing '${n}': stored "${s}" not in allowed [${r.allowed.join(`, `)}]. Reverting to server default "${r.value}".`),window.localStorage.removeItem(a),c(r.value),t[n]=r.value)}else if(typeof r.value==`boolean`){let e=r.value;if(r.locked){let r=U(i,!e);r!==e&&(console.log(`Sanitizing '${n}': setting is locked by server. Client value ${r} is being overwritten with ${e}.`),t[n]=e),window[n]=e}else if(o)window[n]=e,r.overridden&&(t[n]=e);else{let t=U(i,e);window[n]=t,Gt(i,t)}}else r.value!==void 0&&(window[n]=r.value)}return t}function Nn(){try{return RTCRtpReceiver.getCapabilities(`video`).codecs.some(e=>/^video\/vp9$/i.test(e.mimeType)&&/(^|;)profile-id=1(;|$)/.test(e.sdpFmtpLine||``))}catch{return!1}}async function Pn(){let e=i(ne);a(e)&&!await Fn(e)&&U(`video_fullcolor`,!1)&&(console.warn(`[Selkies] full color (4:4:4) is off: this browser decodes ${e} 4:2:0 only over WebRTC.`),Gt(`video_fullcolor`,!1))}async function Fn(e){return e===`vp9`?Nn():await pe(e)}let In=!1;async function G(){if(!window.video_fullcolor||B)return;let e=i(ne);if(a(e)&&!await Fn(e)&&window.video_fullcolor){if(In){console.error(`This session streams ${e} 4:4:4, which this browser cannot decode over WebRTC.`);return}console.warn(`[Selkies] full color (4:4:4) is off: this browser decodes ${e} 4:2:0 only over WebRTC.`),window.video_fullcolor=!1,Gt(`video_fullcolor`,!1),or({video_fullcolor:!1},!1)}}function Ln(){let e=v?v.getBoundingClientRect():null,t=(Ot||{})[H];return qe({stream:v&&v.videoWidth>0?[v.videoWidth,v.videoHeight]:null,css:e&&e.width>0?[e.width,e.height]:null,realized:t?[t.w,t.h]:null,density:At()})}function Rn(){if(B){console.log(`Skipping sending client persisted settings in shared mode.`);return}let e=`${Dt}_`,t={};Pt=At();let n=[`framerate`,`encoder`,`manual_resolution`,`audio_bitrate`,`video_bitrate`,`scaling_dpi`,`enable_binary_clipboard`,`rate_control_mode`,`video_crf`,`use_cpu`,`force_aligned_resolution`,`video_fullcolor`,`video_streaming_mode`,`use_paint_over_quality`,`video_paintover_crf`,`video_paintover_burst_frames`],r=[`manual_resolution`,`enable_binary_clipboard`,`use_cpu`,`video_fullcolor`,`video_streaming_mode`,`use_paint_over_quality`,`force_aligned_resolution`],i=[`framerate`,`audio_bitrate`,`scaling_dpi`,`video_crf`,`video_paintover_crf`,`video_paintover_burst_frames`,`video_bitrate`];for(let a in localStorage)if(Object.hasOwnProperty.call(localStorage,a)&&a.startsWith(e)){let o=a.substring(e.length),s=o;if(o.endsWith(`_display2`)){if(H!==`display2`)continue;s=o.slice(0,-9)}else if(H===`display2`&&Lt.includes(o))continue;if(n.includes(s)){let e=localStorage.getItem(a);if(r.includes(s))e=e===`true`;else if(i.includes(s)&&(e=parseInt(e,10),isNaN(e)))continue;t[s]=e}}t.encoder!==void 0&&!fe(t.encoder)&&(console.log(`Not asking for ${t.encoder}: this browser receives no such WebRTC codec.`),delete t.encoder),window.manualResolution&&T!=null&&E!=null&&(t.manual_resolution=!0,t.manual_width=W(T),t.manual_height=W(E)),t.scaling_dpi===void 0&&(t.scaling_dpi=Hn()),pn&&(t.keyboardLayout=pn),t.useCssScaling=Oe,t.displayScale=Ft=Ln();try{let e=JSON.stringify(t);O.sendDataChannelMessage(`SETTINGS,${e}`),mn=!0,console.log(`Sent initial settings to server:`,t)}catch(e){console.error(`Error constructing or sending initial settings:`,e)}}function zn(e,t,n){if(e<=0||t<=0){console.log(`Invalid target height or width`);return}let r=window.manualResolution?1:At(),i=W(e*r),a=W(t*r);console.log(`applyManualStyle logicalWidth: ${i} logicalHeight: ${a}`),(v.width!==i||v.height!==a)&&(v.width=i,v.height=a,console.log(`Video Element set to: ${e}x${t}`));let o=v.parentElement,s=o.clientWidth,c=o.clientHeight;if(n){let n=e/t,r=s/c,i,a;n>r?(i=s,a=s/n):(a=c,i=c*n);let o=(c-a)/2,l=(s-i)/2;v.style.position=`absolute`,v.style.width=`${i}px`,v.style.height=`${a}px`,v.style.top=`${o}px`,v.style.left=`${l}px`,v.style.objectFit=`contain`,console.log(`Applied manual style (Scaled): CSS ${i}x${a}, Pos ${l},${o}`)}else{let n=window.devicePixelRatio||1,r=e/n,i=t/n,a=(c-i)/2,o=(s-r)/2;v.style.position=`absolute`,v.style.width=`${r}px`,v.style.height=`${i}px`,v.style.top=`${a}px`,v.style.left=`${o}px`,v.style.objectFit=`fill`,console.log(`Applied manual style (Exact): CSS ${r}x${i}, Pos ${o},${a}`)}jn()}function Bn(e,t){if(!v)return;let n=At(),r=W(e*n),i=W(t*n);console.log(`resetToWinRes logicalWidth: ${r} logicalHeight: ${i}`),(v.width!==r||v.height!==i)&&(v.width=r,v.height=i,console.log(`Video Element set to: ${r}x${i}`)),v.style.position=`absolute`,v.style.width=`${Math.round(e)}px`,v.style.height=`${Math.round(t)}px`,v.style.top=`0px`,v.style.left=`0px`,v.style.objectFit=`fill`,console.log(`Resized to window resolution: ${r}x${i} (css ${e}x${t})`)}function Vn(){return window.manualResolution?Ke(T,E):Ge()}function Hn(){return Oe&&!window.manualResolution?96:ke}function Un(){try{O.sendDataChannelMessage(`s,${Hn()}`)}catch{}}function Wn(e){if(B||Kt(`scaling_dpi`,null)!==null)return!1;let t=Vn();return t!==ke&&(ke=t,console.log(`DPI follows ${e}: scaling_dpi -> ${t}.`),window.postMessage({type:`scalingDpiFollowed`,value:t},window.location.origin),!0)}let Gn=window.devicePixelRatio||1;function Kn(){let e=window.devicePixelRatio||1;e!==Gn&&(Gn=e,Wn(`devicePixelRatio changed`)&&Un())}function qn(e,t){if(B){console.log(`Skipping sending resolution in shared mode.`);return}let n,r,i;window.manualResolution?(i=1,n=W(e),r=W(t)):(i=At(),Nt=i,n=W(e*i),Pt>0&&Math.abs(i-Pt)>1e-6&&setTimeout(()=>Rn(),0),r=W(t*i)),n>4080&&(n=4080),r>4080&&(r=4080);let a=`${n}x${r}`;b=[n,r],console.log(`Sending resolution to server: ${a}, Pixel Ratio Used: ${i}, useCssScaling: ${Oe}`),O.sendDataChannelMessage(`r,${a}`)}function Jn(){window.addEventListener(`resize`,Xn)}function Yn(){window.removeEventListener(`resize`,Xn)}window.addEventListener(`resize`,()=>{window.manualResolution&&!B&&T>0&&E>0&&v&&v.parentElement&&zn(T,E,le)});function Xn(){Kn(),me=new Date,be===!1&&(be=!0,setTimeout(()=>{Zn()},ve))}function Zn(){new Date-me<ve?setTimeout(()=>{Zn()},ve):(be=!1,Qn())}function Qn(){if(window.manualResolution||window.enable_resize===!1&&H!==`display2`)return;g=k.getWindowResolution();let e=At();Nt=e,k&&k.setStreamDensity&&k.setStreamDensity(e),g[0]*e>4080&&(g[0]=Math.floor(4080/e)),g[1]*e>4080&&(g[1]=Math.floor(4080/e)),qn(g[0],g[1]),Bn(g[0],g[1])}(()=>{let e=null,t=()=>{Kn(),!window.manualResolution&&!B&&Xn(),n()},n=()=>{if(e)try{e.removeEventListener(`change`,t)}catch{}let n=window.devicePixelRatio||1;e=window.matchMedia(`(resolution: ${n}dppx)`),e.addEventListener(`change`,t,{once:!0})};n(),setInterval(Kn,1e3)})();function $n(){if(B){console.log(`Skipping loading last session settings in shared mode.`);return}if(O&&Un(),Ze&&O)try{O.sendDataChannelMessage(`SET_NATIVE_CURSOR_RENDERING,1`)}catch{}if(window.manualResolution&&T&&E)console.log(`Applying manual resolution: ${T}x${E}`),zn(T,E,le),window.location.hash.startsWith(`#display2`)&&qn(T,E);else{console.log(`Applying window resolution`);let e=k.getWindowResolution();Bn(...e),(window.enable_resize!==!1||H===`display2`)&&qn(e[0],e[1]),Jn()}}function er(){let e={type:`sidebarButtonStatusUpdate`,video:A,audio:Ae,microphone:Me,webcam:Ne,gamepad:N};console.log(`Posting sidebarButtonStatusUpdate:`,e),window.postMessage(e,window.location.origin)}function tr(e,t=!1){O.setMicrophone(e,oe).then(()=>{Me=e,er()}).catch(n=>{console.error(`Microphone toggle failed:`,n),Me=!1,e&&t&&ye(n)&&(Pe=!0),er()})}async function nr(e=!1){if(!(B||!O||Ne||M)){M=!0;try{if(await O.setWebcam(!0,null,{codec:Ie})){let e=O.webcamTrack;e&&e.addEventListener(`ended`,()=>{Ne&&rr()}),Ne=!0}else Ne=!1,e&&(Fe=!0)}catch(t){console.error(`Webcam capture error:`,t),Ne=!1,e&&ye(t)&&(Fe=!0)}finally{M=!1}er()}}function rr(){O&&O.setWebcam(!1).catch(()=>{}),Ne&&(Ne=!1,er())}function ir(){if(k&&k.gamepadManager){if(B)return k.gamepadManager.enable(),console.log(`Shared mode: Gamepad control message received, ensuring its GamepadManager remains active for polling.`),!0;if(N)return k.gamepadManager.enable(),console.log(`Primary mode: Gamepad toggle ON. Enabling GamepadManager polling.`),!0;k.gamepadManager.disable(),console.log(`Primary mode: Gamepad toggle OFF. Disabling GamepadManager polling.`)}else console.warn(`Client: input.gamepadManager not found in 'gamepadControl' message handler`);return!1}function ar(e){if(e.origin!==window.location.origin){console.warn(`Received message from unexpected origin`);return}let t=e.data;switch(t.type){case`statsOpen`:Te.setOpen(t.open);break;case`setScaleLocally`:if(B)break;typeof t.value==`boolean`?(le=t.value,Gt(`scaleLocallyManual`,le),console.log(`Set scaleLocallyManual to ${le} and persisted.`),window.manualResolution&&T&&E&&zn(T,E,le)):console.warn(`Invalid value received for setScaleLocally:`,t.value);break;case`resetResolutionToWindow`:if(B)break;console.log(`Resetting to window size`),window.manualResolution=!1,E=T=0,Ut(`manual_width`,null),Ut(`manual_height`,null),Gt(`manual_resolution`,!1),Wn(`manual resolution cleared`),Jn(),Qn(),Un();break;case`setManualResolution`:if(B)break;let e=parseInt(t.width,10),n=parseInt(t.height,10);if(isNaN(e)||e<=0||isNaN(n)||n<=0){console.error(`Received invalid width/height for setManualResolution:`,t);break}console.log(`Setting manual resolution: ${e}x${n}`),window.manualResolution=!0,T=e,E=n,Ut(`manual_width`,T),Ut(`manual_height`,E),Gt(`manual_resolution`,!0),Yn(),Wn(`manual resolution set`),qn(T,E),Un(),zn(T,E,le);break;case`setUseCssScaling`:if(B)break;if(typeof t.value==`boolean`){let e=Oe!==t.value;if(Oe=t.value,t.persist!==!1&&Gt(`useCssScaling`,Oe),console.log(`Set useCssScaling to ${Oe}${t.persist===!1?`.`:` and persisted.`}`),k&&typeof k.updateCssScaling==`function`&&k.updateCssScaling(Oe),e){if(jn(),window.manualResolution&&T!=null&&E!=null)qn(T,E),zn(T,E,le);else if(!B&&k&&(window.enable_resize!==!1||H===`display2`)){let e=k.getWindowResolution(),t=W(e[0]),n=W(e[1]);qn(t,n),Bn(t,n)}Un()}}else console.warn(`Invalid value received for setUseCssScaling:`,t.value);break;case`settings`:console.log(`Received settings msg from dashboard:`,t.settings),or(t.settings);break;case`command`:if(B)break;if(!_n){console.log(`Command sending suppressed: server has command_enabled=false; not sending 'cmd,'.`);break}if(t.value!==null&&t.value!==void 0){let e=t.value;console.log(`Received 'command' message with value: "${e}"`),O.sendDataChannelMessage(`cmd,${e}`)}else console.warn(`Received invalid command from dashboard: ${t.value}`);break;case`pipelineControl`:if(t.pipeline===`microphone`&&B){console.log(`Shared mode: Microphone control blocked.`);break}if(t.pipeline===`microphone`&&O&&typeof O.setMicrophone==`function`)j.add(`microphone`),Pe=!1,tr(!!t.enabled);else if(t.pipeline===`video`&&B){console.log(`Shared mode: Video pipelineControl blocked.`);break}else if(t.pipeline===`video`&&O){j.add(`video`);let e=!!t.enabled;try{O.sendDataChannelMessage(e?`START_VIDEO`:`STOP_VIDEO`),A=e,window.postMessage({type:`pipelineStatusUpdate`,video:e},window.location.origin),er()}catch(e){console.error(`Video toggle failed:`,e)}}else if(t.pipeline===`audio`){if(j.add(`audio`),!v)break;let e=!!t.enabled;if(v.muted=!e,Ae=e,O)try{O.sendDataChannelMessage(e?`START_AUDIO`:`STOP_AUDIO`)}catch(e){console.error(`Audio toggle failed:`,e)}window.postMessage({type:`pipelineStatusUpdate`,audio:e},window.location.origin),er()}else if(t.pipeline===`webcam`){if(B){console.log(`Shared mode: Webcam control blocked.`);break}j.add(`webcam`),Fe=!1,t.enabled?nr():rr()}break;case`gamepadControl`:console.log(`Received gamepad control message: enabled=${t.enabled}`);let r=t.enabled;j.add(`gamepad`),N!==r&&(N=r,Gt(`isGamepadEnabled`,N),er(),ir());break;case`clipboardUpdateFromUI`:if(console.log(`Received clipboardUpdateFromUI message.`),B){console.log(`Shared mode: Clipboard write to server blocked.`);break}hr.sendExplicit(t.text);break;case`printRequest`:sn(t.url);break;case`clipboardImageUpdate`:if(B){console.log(`Shared mode: Clipboard image write to server blocked.`),xr(`viewers cannot set the clipboard`,`clipboardSkipReadonly`);break}if(!t.imageBlob){xr(`no image selected`,`clipboardSkipNoImage`);break}if(!lt){xr(`image clipboard is disabled on the server (enable_binary_clipboard)`,`clipboardSkipBinaryDisabled`);break}hr.sendExplicit(t.imageBlob,t.imageBlob.type||`image/png`,xr).catch(e=>{console.warn(`Failed to send uploaded clipboard image:`,e),xr(`send failed: `+e.message,`clipboardSkipSendFailed`)});break;case`audioDeviceSelected`:t.context===`output`&&t.deviceId?(S=t.deviceId,On()):t.context===`input`&&t.deviceId&&(oe=t.deviceId,Me&&O&&typeof O.setMicrophone==`function`&&O.setMicrophone(!1).then(()=>O.setMicrophone(!0,oe)).catch(e=>{console.error(`Microphone device switch failed:`,e),Me=!1,er()}));break;case`requestFullscreen`:case`requestGamingMode`:{let e=t.type===`requestGamingMode`;l=e,k&&e&&typeof k.enterGamingMode==`function`?k.enterGamingMode():k?k.enterFullscreen():document.fullscreenElement===null&&document.documentElement.requestFullscreen().catch(()=>{});break}case`setSynth`:k&&typeof k.setSynth==`function`&&k.setSynth(t.value);break;case`showVirtualKeyboard`:{if(B)break;let e=document.getElementById(`keyboard-input-assist`),t=document.getElementById(`overlayInput`);e&&(e.value=``,e.focus(),t&&t.addEventListener(`touchstart`,()=>{document.activeElement===e&&e.blur()},{once:!0,passive:!0}));break}case`setAntiAliasing`:typeof t.value==`boolean`?(We=t.value,Gt(`antiAliasingEnabled`,We),jn()):console.warn(`Invalid value received for setAntiAliasing:`,t.value);break;case`setUseBrowserCursors`:typeof t.value==`boolean`?($e=t.value,Gt(`use_browser_cursors`,t.value),Xt()):console.warn(`Invalid value received for setUseBrowserCursors:`,t.value);break;case`setRawPointerMotion`:typeof t.value==`boolean`?(nt=t.value,Gt(`raw_pointer_motion`,t.value),Zt()):console.warn(`Invalid value received for setRawPointerMotion:`,t.value);break;case`setMacCmdAsCtrl`:typeof t.value==`boolean`?(Qt=t.value,Gt(`mac_cmd_as_ctrl`,t.value),$t()):console.warn(`Invalid value received for setMacCmdAsCtrl:`,t.value);break;case`touchinput:trackpad`:if(k&&typeof k.setTrackpadMode==`function`&&(Ze=!0,Gt(`trackpadMode`,!0),k.setTrackpadMode(!0),O))try{O.sendDataChannelMessage(`SET_NATIVE_CURSOR_RENDERING,1`)}catch{}break;case`touchinput:touch`:if(k&&typeof k.setTrackpadMode==`function`&&(Ze=!1,Gt(`trackpadMode`,!1),k.setTrackpadMode(!1),O))try{O.sendDataChannelMessage(`SET_NATIVE_CURSOR_RENDERING,0`)}catch{}}}function or(e,i){let a=i?()=>{}:Ut,s=i?()=>{}:Gt,c=i?()=>{}:Jt;if(e.webcam_encoder!==void 0){let t=String(e.webcam_encoder);qt.includes(t)&&t!==Ie&&(Ie=t,c(`webcam_encoder`,t),O&&Ne&&O.setWebcamCodec(t).catch(()=>{}))}if(e.debug!==void 0){ue=e.debug,Gt(`debug`,ue),console.log(`Applied debug setting: ${ue}. Reloading...`),setTimeout(()=>{window.location.reload()},700);return}let l={};if(e.video_fullcolor!==void 0&&(l.video_fullcolor=!!e.video_fullcolor),e.video_streaming_mode!==void 0&&(l.video_streaming_mode=!!e.video_streaming_mode),e.use_paint_over_quality!==void 0&&(l.use_paint_over_quality=!!e.use_paint_over_quality),e.video_paintover_crf!==void 0&&(l.video_paintover_crf=parseInt(e.video_paintover_crf,10)),e.video_paintover_burst_frames!==void 0&&(l.video_paintover_burst_frames=parseInt(e.video_paintover_burst_frames,10)),e.force_aligned_resolution!==void 0&&(l.force_aligned_resolution=!!e.force_aligned_resolution),e.use_cpu!==void 0&&(l.use_cpu=!!e.use_cpu),e.encoder!==void 0&&(l.encoder=e.encoder),e.displayPosition!==void 0&&(l.displayPosition=e.displayPosition),Object.keys(l).length>0&&O.sendDataChannelMessage(`SETTINGS,${JSON.stringify(l)}`),e.video_bitrate!==void 0&&(n=parseInt(e.video_bitrate,10),O.sendDataChannelMessage(`vb,${n}`),a(`video_bitrate`,n)),e.framerate!==void 0&&(r=parseInt(e.framerate),O.sendDataChannelMessage(`_arg_fps,${r}`),a(`framerate`,r)),e.audio_bitrate!==void 0&&(o=parseInt(e.audio_bitrate),O.sendDataChannelMessage(`ab,${o}`),a(`audio_bitrate`,o)),e.encoder!==void 0&&(ne=e.encoder,c(`encoder`,ne),console.log(`Encoder switched to:`,ne)),e.scaling_dpi!==void 0){let t=parseInt(e.scaling_dpi,10);!isNaN(t)&&t>0&&(ke=t,Un(),Oe&&!window.manualResolution&&!B&&Qn())}if(e.enable_binary_clipboard!==void 0&&(lt=!!e.enable_binary_clipboard,O.sendDataChannelMessage(`_ebc,${lt}`),s(`enable_binary_clipboard`,lt),console.log(`Binary clipboard support ${lt?`enabled`:`disabled`}`)),e.keyboard_shortcuts!==void 0&&(en=!!e.keyboard_shortcuts,s(`keyboard_shortcuts`,en),nn()),e.print_auto!==void 0&&tn&&(tn.setAutomatic(e.print_auto),s(`print_auto`,!!e.print_auto)),e.clipboard_seamless!==void 0&&(te=!!e.clipboard_seamless,s(`clipboard_seamless`,te)),e.clipboard_in_enabled!==void 0&&(h=!!e.clipboard_in_enabled,s(`clipboard_in_enabled`,h)),e.clipboard_out_enabled!==void 0&&(ee=!!e.clipboard_out_enabled,s(`clipboard_out_enabled`,ee)),e.use_css_scaling!==void 0&&ar({origin:window.location.origin,data:{type:`setUseCssScaling`,value:!!e.use_css_scaling,persist:!i}}),e.use_browser_cursors!==void 0&&($e=!!e.use_browser_cursors,Xt()),e.raw_pointer_motion!==void 0&&(nt=!!e.raw_pointer_motion,Zt()),e.mac_cmd_as_ctrl!==void 0&&(Qt=!!e.mac_cmd_as_ctrl,$t()),e.rate_control_mode!==void 0&&(re=e.rate_control_mode,O.sendDataChannelMessage(`_rc,${re}`),sr(re),c(`rate_control_mode`,re),console.log(`Rate control mode set to ${re}`)),e.video_crf!==void 0&&(t=parseInt(e.video_crf,10),O.sendDataChannelMessage(`_crf,${t}`),a(`video_crf`,t),console.log(`Video CRF set to ${t}`)),e.force_aligned_resolution!==void 0){if(ot=!!e.force_aligned_resolution,s(`force_aligned_resolution`,ot),window.manualResolution&&T!=null&&E!=null)qn(T,E);else if(!B&&k&&(window.enable_resize!==!1||H===`display2`)){let e=k.getWindowResolution();qn(e[0],e[1])}}}function sr(e){e===`cbr`?O.sendDataChannelMessage(`vb,${n}`):e===`crf`&&O.sendDataChannelMessage(`_crf,${t}`)}let cr=vt({canUpload:()=>!B}),lr=cr.handleRequestFileUpload,ur=cr.handleFileInputChange,dr=cr.handleDragOver,fr=cr.handleDrop;function pr(e,t,n,r){let i=`${e}:${t}x${n}`;i!==we.key&&e&&e!==`NA`&&t>0&&(we={key:i,efficient:null},navigator.mediaCapabilities&&navigator.mediaCapabilities.decodingInfo&&navigator.mediaCapabilities.decodingInfo({type:`webrtc`,video:{contentType:`video/${e}`,width:t,height:n,bitrate:8e6,framerate:r>0?r:60}}).then(e=>{we.key===i&&(we.efficient=e.supported?!!e.powerEfficient:null)}).catch(()=>{}))}function mr(e,t,n){let r=e.reports.videoRTP||{},i=e.reports.audioRTP||{},a=e.reports.candidatePairs[e.reports.selectedCandidatePairId]||{},o=e.reports.localCandidates[a.localCandidateId]||{},s={at:performance.now(),framesDecoded:r.framesDecoded||0,totalDecodeTime:r.totalDecodeTime||0,jitterBufferDelay:r.jitterBufferDelay||0,jitterBufferEmittedCount:r.jitterBufferEmittedCount||0,audioJitterBufferDelay:i.jitterBufferDelay||0,audioJitterBufferEmittedCount:i.jitterBufferEmittedCount||0,received:(r.packetsReceived||0)+(i.packetsReceived||0),lost:(r.packetsLost||0)+(i.packetsLost||0),micBytes:(e.reports.outbound.audio||{}).bytesSent||0,webcamBytes:(e.reports.outbound.video||{}).bytesSent||0},c={framesDropped:r.framesDropped||0,nack:r.nackCount||0,pli:r.pliCount||0,freezes:r.freezeCount||0},l=Ce;if(Ce=Object.assign({opened:l?l.opened:c},s),pr(e.video.codecName,e.video.frameWidth,e.video.frameHeight,e.video.framesPerSecond),Te.setClient(Object.assign({sink:`<video> element`,codec:e.video.codecName===`NA`?``:e.video.codecName,resolution:e.video.frameWidth>0?`${e.video.frameWidth}x${e.video.frameHeight}`:``,path:[e.general.connectionType===`NA`?``:e.general.connectionType,o.relayProtocol?`${o.relayProtocol} relay`:o.protocol||``].filter(Boolean).join(` `)},dn({implementation:r.decoderImplementation,powerEfficient:r.powerEfficientDecoder,capable:we.efficient}))),!l)return;let u=(s.at-l.at)/1e3,d=(e,t)=>t>0?Math.round(1e3*e/t*100)/100:0,f=(e,t)=>t>0?Math.round(100*e/t*100)/100:0,p=e=>u>0?Math.round(e*8/1e3/u):0,m={fps:e.video.framesPerSecond||0,mbps:Math.round(n*100)/100,rtt_ms:Math.round(t*10)/10,decode_ms:d(s.totalDecodeTime-l.totalDecodeTime,s.framesDecoded-l.framesDecoded),jitter_buffer_ms:d(s.jitterBufferDelay-l.jitterBufferDelay,s.jitterBufferEmittedCount-l.jitterBufferEmittedCount),audio_buffer_ms:d(s.audioJitterBufferDelay-l.audioJitterBufferDelay,s.audioJitterBufferEmittedCount-l.audioJitterBufferEmittedCount),packet_loss_percent:f(s.lost-l.lost,s.received-l.received+(s.lost-l.lost)),frames_dropped:c.framesDropped-Ce.opened.framesDropped,nacks:c.nack-Ce.opened.nack,keyframe_requests:c.pli-Ce.opened.pli,freezes:c.freezes-Ce.opened.freezes};e.reports.outbound.audio&&s.micBytes>l.micBytes&&(m.mic=`Opus, ${p(s.micBytes-l.micBytes)} kbps`);let h=e.reports.outbound.video;if(h&&s.webcamBytes>l.webcamBytes){let e=h.qualityLimitationReason&&h.qualityLimitationReason!==`none`?`, limited by ${h.qualityLimitationReason}`:``;m.webcam=`${h.frameWidth||0}x${h.frameHeight||0} at ${Math.round(h.framesPerSecond||0)} fps, ${p(s.webcamBytes-l.webcamBytes)} kbps${e}`}Te.clientSample(m)}function K(){if(B){console.log(`Shared mode detected, skipping stats watch setup.`);return}var e=0,t=0,n=0,r=0,i=0,a=0,o=new Date().getTime()/1e3;if(Ee!==null)return;Se=!0;let s=!1;Ee=setInterval(async()=>{if(!s){s=!0;var c=new Date().getTime()/1e3;try{let s=await O.getConnectionStats();_={};let l=s.general.currentRoundTripTime===null?se:s.general.currentRoundTripTime*1e3;_.connectionPacketsReceived=s.general.packetsReceived,_.connectionPacketsLost=s.general.packetsLost,_.connectionStatType=s.general.connectionType,_.connectionBytesReceived=(s.general.bytesReceived*1e-6).toFixed(2)+` MBytes`,_.connectionBytesSent=(s.general.bytesSent*1e-6).toFixed(2)+` MBytes`,_.connectionAvailableBandwidth=(parseInt(s.general.availableReceiveBandwidth)/1e6).toFixed(2)+` mbps`,_.connectionCodec=s.video.codecName,_.connectionVideoDecoder=s.video.decoder,_.connectionResolution=s.video.frameWidth+`x`+s.video.frameHeight,_.connectionFrameRate=s.video.framesPerSecond,_.connectionVideoBitrate=((s.video.bytesReceived-e)/(c-o)*8/1e6).toFixed(2),e=s.video.bytesReceived,_.connectionAudioCodecName=s.audio.codecName,_.connectionAudioBitrate=((s.audio.bytesReceived-t)/(c-o)*8/1e3).toFixed(2),t=s.audio.bytesReceived,_.connectionAudioConcealedSamples=s.audio.concealedSamples,_.connectionAudioConcealmentEvents=s.audio.concealmentEvents,_.connectionAudioTotalSamplesReceived=s.audio.totalSamplesReceived,_.connectionAudioPacketsDiscarded=s.audio.packetsDiscarded,o=c,_.connectionVideoLatency=parseInt(Math.round(l+(1e3*(s.video.jitterBufferDelay-n)/(s.video.jitterBufferEmittedCount-r)||0))),n=s.video.jitterBufferDelay,r=s.video.jitterBufferEmittedCount,_.connectionAudioLatency=parseInt(Math.round(l+(1e3*(s.audio.jitterBufferDelay-i)/(s.audio.jitterBufferEmittedCount-a)||0)));let u=1e3*(s.audio.jitterBufferDelay-i)/(s.audio.jitterBufferEmittedCount-a)||0;window.currentAudioBufferSize=Math.max(0,Math.round(u/20)),i=s.audio.jitterBufferDelay,a=s.audio.jitterBufferEmittedCount,_.connectionLatency=Math.max(_.connectionVideoLatency,_.connectionAudioLatency),window.fps=_.connectionFrameRate,Te.open&&mr(s,l,(parseFloat(_.connectionVideoBitrate)||0)+(parseFloat(_.connectionAudioBitrate)||0)/1e3),D&&O.sendDataChannelMessage(`_stats_video,${JSON.stringify(s.allReports)}`)}catch(e){O!==null&&console.warn(`Error collecting connection stats:`,e)}finally{s=!1}}},1e3)}let hr=st({isChromium:xt,getDeferredWriteInFlight:()=>z.getInFlight(),isSharedMode:()=>B,canSync:()=>m===`enabled`&&!!window.clipboard_enabled&&te,canRead:()=>!!h,binaryEnabled:()=>!!lt,sendClipboardData:(e,t,n)=>Cr(e,t,n),dedupeText:!0}),gr=()=>hr.readAndSend(),_r=()=>hr.maybeInitial(),vr=ft({isChromium:xt,clipboardSync:R,sendClipboardData:(e,t)=>Cr(e,t),canSync:()=>!B&&m===`enabled`&&!!window.clipboard_enabled&&te,canRead:()=>!!h,canWrite:()=>!!ee,binaryEnabled:()=>!!lt,getSendInFlight:()=>hr.getSendInFlight(),getDeferredWriteInFlight:()=>z.getInFlight()});async function yr(){O.sendDataChannelMessage(`kr`),xt&&gr()}function br(){O.sendDataChannelMessage(`kr`)}function xr(e,t){console.warn(`Clipboard image upload skipped: `+e),window.postMessage({type:`fileUpload`,payload:{status:`warning`,fileName:`clipboard-image`,message:e,code:t}},window.location.origin)}function Sr(e){let t=Xe()||e&&e.message||String(e);console.error(`Failed to write the session image to the local clipboard:`,e),window.postMessage({type:`fileUpload`,payload:{status:`warning`,fileName:`clipboard-image`,message:t,code:`clipboardImageWriteFailed`}},window.location.origin)}async function Cr(e,t=`text/plain`,n=null){let r=(e,t)=>{n&&n(e,t)};if(e==null){r(`nothing to send`,`clipboardSkipNoImage`);return}if(m!==`enabled`||window.clipboard_enabled===void 0){r(`the session has not reported its clipboard policy yet`,`clipboardSkipNotConnected`);return}if(!window.clipboard_enabled){r(`the server has the clipboard turned off`,`clipboardSkipDisabled`);return}if(!h){r(`the client-to-session clipboard is turned off`,`clipboardSkipInDisabled`);return}if(!O||!O.dataChannelOpen()){r(`not connected`,`clipboardSkipNotConnected`);return}let i=e instanceof ArrayBuffer||e instanceof Uint8Array,a;i?a=e instanceof Uint8Array?e:new Uint8Array(e):(a=new TextEncoder().encode(e),t=`text/plain`);let o=e;if(i)try{let{byteLength:e,hash:t}=await pt.hashBytes(a.slice().buffer);o=Je(e,t)}catch{}if(!R.shouldSend(o,t)){r(`already the current clipboard`,`clipboardSkipUnchanged`);return}try{if(await Ct(a,t,{worker:pt,send:e=>O.sendDataChannelMessage(e),waitDrain:async()=>(O.waitForDataChannelDrain&&await O.waitForDataChannelDrain(65536),!0),chunkRawBytes:Math.min(16383,Math.max(1,Math.floor(Le()*3/4))),nextTid:()=>++gn}),!O.dataChannelOpen()){r(`connection lost during send`,`clipboardSkipSendFailed`);return}R.markSynced(o,t)}catch(e){console.error(`Error sending clipboard data:`,e),r(`send failed: `+(e&&e.message?e.message:e),`clipboardSkipSendFailed`)}}async function wr(e){if(!e.data)return console.warn(`Received clipboard message with null data`),{isMultipart:!1,mimeType:null,content:null};let t=e.data.mime_type||mt.mimeType,n=t===`text/plain`,r=null,i=null;switch(e.type){case`clipboard-msg`:let a;try{let{result:r}=await pt.decode(e.data.content,t);if(n)return{isMultipart:!1,mimeType:t,content:r};if(t===`application/x-selkies-clipboard-flavours`){if(typeof ClipboardItem>`u`)return{isMultipart:!1,mimeType:t,content:null};let e=et(r);return{isMultipart:!1,mimeType:t,content:tt(e),preview:e.text||e.html}}a=new Blob([r],{type:t}),t.startsWith(`image/`)&&t!==`image/png`&&(a=await bt(a),t=`image/png`)}catch(e){return console.error(`Image conversion failed for clipboard message:`,e),{isMultipart:!1,mimeType:t,content:null}}return typeof ClipboardItem>`u`?{isMultipart:!1,mimeType:t,content:null}:{isMultipart:!1,mimeType:t,content:new ClipboardItem({[t]:a})};case`clipboard-msg-start`:return mt.begin(t,e.data.total_size),console.log(`Starting multi-part download: ${t}, expected raw size: ${e.data.total_size}`),{isMultipart:!0,mimeType:t,content:null};case`clipboard-msg-data`:return mt.push(e.data.content),{isMultipart:!0,mimeType:t,content:null};case`clipboard-msg-end`:if(!mt.inProgress)return{isMultipart:!1,mimeType:t,content:null};t=mt.mimeType;let o=mt.totalSize;try{let{result:e,byteLength:n}=await mt.finish();if(n!==o)return console.warn(`Size mismatch! Expected ${o}, got ${n}`),{isMultipart:!1,mimeType:t,content:null};if(t===`text/plain`)r=e;else if(typeof ClipboardItem>`u`)r=null;else if(t===`application/x-selkies-clipboard-flavours`){let t=et(e);r=tt(t),i=t.text||t.html}else{let n=new Blob([e],{type:t});t.startsWith(`image/`)&&t!==`image/png`&&(n=await bt(n),t=`image/png`),r=new ClipboardItem({[t]:n})}}catch(e){console.error(`Worker decoding failed:`,e)}return{isMultipart:!1,mimeType:t,content:r,preview:i};default:console.warn(`Unknown clipboard cmd received`)}}return{initialize(){vn();let i=document.getElementById(`app`),a=document.createElement(`div`);a.className=`video-container`,C=document.createElement(`button`),C.id=`playButton`,C.textContent=`Play Stream`,C.classList.add(`hidden`),C.addEventListener(`click`,ln),w=document.createElement(`div`),w.id=`status-display`,w.className=`status-bar`,w.textContent=`Connecting...`;let x=document.createElement(`input`);x.type=`search`,x.readOnly=!1,x.autocomplete=`off`,x.inputMode=`none`,x.virtualKeyboardPolicy=`manual`,x.setAttribute(`autocorrect`,`off`),x.setAttribute(`autocapitalize`,`off`),x.setAttribute(`spellcheck`,`false`),x.id=`overlayInput`,v=document.createElement(`video`),v.id=`stream`,v.className=`video`,v.autoplay=!0,v.playsInline=!0,v.addEventListener(`resize`,()=>{let e=v.videoWidth,t=v.videoHeight;e>0&&t>0&&b&&(window.streamResolutionDiverged=e!==b[0]||t!==b[1]),mn&&!B&&Ft>0&&Math.abs(Ln()-Ft)>1e-6&&Rn()});let S=document.createElement(`input`);if(S.type=`file`,S.id=`globalFileInput`,S.multiple=!0,S.style.display=`none`,document.body.appendChild(S),S.addEventListener(`change`,ur),a.appendChild(v),a.appendChild(C),a.appendChild(w),a.appendChild(x),i.appendChild(a),!document.getElementById(`keyboard-input-assist`)){let e=document.createElement(`input`);e.type=`search`,e.id=`keyboard-input-assist`,e.style.position=`absolute`,e.style.left=`-9999px`,e.style.top=`-9999px`,e.style.width=`1px`,e.style.height=`1px`,e.style.opacity=`0`,e.style.border=`0`,e.style.padding=`0`,e.style.caretColor=`transparent`,e.setAttribute(`aria-hidden`,`true`),e.setAttribute(`autocomplete`,`off`),e.setAttribute(`autocorrect`,`off`),e.setAttribute(`autocapitalize`,`off`),e.setAttribute(`spellcheck`,`false`),document.body.appendChild(e),console.log(`Dynamically added #keyboard-input-assist element.`)}e=`webrtc`,ue=U(`debug`,!1),de=U(`turn_switch`,!1),ce=U(`resize_remote`,ce),le=U(`scaleLocallyManual`,!ce),n=zt(`video_bitrate`,n),r=zt(`framerate`,r),o=zt(`audio_bitrate`,o),window.manualResolution=U(`manual_resolution`,!1),N=U(`isGamepadEnabled`,!0),T=zt(`manual_width`,null),E=zt(`manual_height`,null),ne=Kt(`encoder`,`h264enc`),re=Kt(`rate_control_mode`,`cbr`),Oe=U(`useCssScaling`,!1),ke=Kt(`scaling_dpi`,null)===null?Vn():zt(`scaling_dpi`,96),lt=U(`enable_binary_clipboard`,lt),h=U(`clipboard_in_enabled`,h),ee=U(`clipboard_out_enabled`,ee),te=U(`clipboard_seamless`,te),en=U(`keyboard_shortcuts`,en),tn=cn({automatic:U(`print_auto`,!0)}),t=zt(`video_crf`,t),We=U(`antiAliasingEnabled`,!0),Ze=U(`trackpadMode`,!1),$e=U(`use_browser_cursors`,!0),nt=U(`raw_pointer_motion`,Re.rawPointerMotion),ot=U(`force_aligned_resolution`,!1),B||(window.addEventListener(`message`,ar),window.addEventListener(`requestFileUpload`,lr),x.addEventListener(`dragover`,dr),x.addEventListener(`drop`,fr)),document.addEventListener(`visibilitychange`,Dn);let oe=wt.startsWith(`#display2`)?`display2`:`primary`,fe=`right`;if(oe===`display2`){let e=wt.match(/^#display2-(right|left|up|down)/);e&&(fe=e[1])}Ot=null;var pe=he()+`/`,me=location.protocol==`http:`?`ws://`:`wss://`,ge=new URL(me+window.location.host+pe+`api/`+e+`/signaling/`),_e=new URLSearchParams(window.location.search).get(`token`)||void 0;y=!1;let ve=null;var ye=new Ve(ge,Ue,L,Tt,_e,oe,fe);ye.capabilities=async()=>{let e=[];for(let t of[`h264`,`h265`,`vp9`])await Fn(t)&&e.push(t);return e},ye.onfatalretry=async()=>{let e=null;try{e=sessionStorage.getItem(`selkies_mode_flip`)}catch{}if(!e)try{let e=new URL(ge.href);if(e.protocol=location.protocol===`http:`?`http:`:`https:`,(await fetch(e.href,{cache:`no-store`,headers:ht()})).status===409){try{sessionStorage.setItem(`selkies_mode_flip`,`1`)}catch{}Jt(`stream_mode`,`websockets`),console.warn(`[signaling] Server is serving WebSockets (endpoint 409); switching stored mode.`)}}catch{}location.reload()},O=new Be(ye,v,1),hn=O,k=new Re(x,e=>{B&&Tt&&!Et||O.sendDataChannelMessage(e)},B,ze,Oe),k.sendMotion=e=>{B&&Tt&&!Et||O.sendMotionMessage(e)},k.setShortcutsEnabled(en),k.setDisplayLayouts(Ot,oe),k.ongamepadconnected=e=>{ir()&&(ie.gamepadState=`connected`,ie.gamepadName=e,O._setStatus(`Gamepad connected: `+e))},k.ongamepaddisconnected=()=>{ie.gamepadState=`disconnected`,ie.gamepadName=`none`,O._setStatus(`Gamepad disconnected`)},B||(window.addEventListener(`focus`,yr),window.addEventListener(`blur`,br),vr.wire()),k.attach(),k.getWindowResolution=()=>{let e=v&&v.parentElement;if(!e)return[window.innerWidth,window.innerHeight];let t=e.getBoundingClientRect();return[t.width,t.height]},window.webrtcInput=k,Ze&&k.setTrackpadMode(!0),Xt(),Zt(),$t(),window.postMessage({type:`trackpadModeUpdate`,enabled:Ze},window.location.origin),window.postMessage({type:`clientRoleUpdate`,role:Ue},window.location.origin),ye.onstatus=e=>{u(d,Yt(`[signaling] `+e)),console.log(`[signaling] `+e)},ye.onerror=e=>{u(d,Yt(`[signaling] [ERROR] `+e)),console.log(`[signaling ERROR] `+e)},ye.ondisconnect=e=>{v.style.cursor=`auto`,yn(),window.__selkiesAuthProbe&&window.__selkiesAuthProbe(),e?(p=`connecting`,j.clear(),je=!1,A=!0,Ae=!0,v.muted=!1,O.reset()):p=`disconnected`,An()},ye.onshowalert=e=>{y=!0,!(typeof window<`u`&&window.__selkiesModeSwitching)&&alert(`Disconnected: `+e+` Please try again.`)},O.onstatus=e=>{u(d,Yt(`[webrtc] `+e)),console.log(`[webrtc] `+e)},O.onerror=e=>{u(d,Yt(`[webrtc] [ERROR] `+e)),console.log(`[webrtc] [ERROR] `+e)},ue&&(ye.ondebug=e=>{u(f,`[signaling] `+e)},O.ondebug=e=>{u(f,Yt(`[webrtc] `+e))}),O.onstreaminfo=e=>Te.setInfo(e),O.onstreamstats=e=>Te.serverSample(e),O.onconnectionstatechange=e=>{if(xe=e,xe===`connected`){p=e;try{sessionStorage.removeItem(`selkies_mode_flip`)}catch{}ve!==null&&(clearTimeout(ve),ve=null),Se||K(),un(),On()}else(e===`failed`||e===`disconnected`)&&!y&&ve===null&&(ve=setTimeout(()=>{ve=null;let e=O.peerConnection&&O.peerConnection.connectionState;e===`connected`||y||typeof window<`u`&&window.__selkiesModeSwitching||(console.warn(`[webrtc] connection ${e}; reloading to reconnect.`),location.reload())},e===`failed`?1500:8e3));An()},O.ondatachannelopen=()=>{console.log(`Data channel opened`),Te.subscribe();try{gt.armLegacyWindow(5e3),O.sendDataChannelMessage(`cr`)}catch(e){console.warn(`Failed to send initial clipboard request (cr):`,e)}if(k&&k.resyncGamepads(),B){console.log(`Shared mode: skipping loading of last session settings and sending persisted settings to server`);return}$n(),Pn().then(Rn),De!==null&&clearInterval(De),De=setInterval(async()=>{_.connectionFrameRate===parseInt(_.connectionFrameRate,10)&&O.sendDataChannelMessage(`_f,${_.connectionFrameRate}`),_.connectionLatency===parseInt(_.connectionLatency,10)&&O.sendDataChannelMessage(`_l,${_.connectionLatency}`)},5e3)},k.onmenuhotkey=()=>{c=!c,window.postMessage({type:`toggleDashboard`},window.location.origin)},k.ongamepadhotkey=()=>{window.postMessage({type:`toggleTouchGamepad`},window.location.origin)},k.gamingMode=l,k.ongamingmode=e=>{l=e,window.postMessage({type:`gamingModeUpdate`,active:e},window.location.origin)},k.onnotice=(e,t)=>{window.postMessage({type:`fileUpload`,payload:{status:`warning`,fileName:e,message:t,code:e}},window.location.origin)},O.onplaystreamrequired=()=>{s=!0},O.onclipboardcontent=async e=>{if(e.data&&e.data.reply_to===`cr`&&_t(),B)return;let t=yt(),{isMultipart:n,mimeType:r,content:i,preview:a}=await wr(e),o=r===`text/plain`,s=r===Qe;if(n||i===null)return;let c=!t&&te&&m===`enabled`&&ee;if(o){let e=R.shouldSend(i,`text/plain`);R.resolveServer(i,null,`text/plain`),window.postMessage(ut(i),window.location.origin),c&&e&&z.write(()=>navigator.clipboard.writeText(i),{onSuccess:()=>console.log(`Successfully wrote text from server to local clipboard.`),onFailure:e=>console.log(`Could not copy text to clipboard: `,e)})}else if(s){let e=Je(a.length,a),t=R.shouldSend(e,r);R.resolveServer(a,null,r,e),window.postMessage(ut(a),window.location.origin),c&&t&&z.write(()=>navigator.clipboard.write([i]),{onFailure:e=>console.log(`Could not copy session markup to clipboard: `,e)})}else if(lt){let e=!0;try{let t=await i.getType(r),{byteLength:n,hash:a}=await pt.hashBytes(await t.arrayBuffer()),o=Je(n,a);e=R.shouldSend(o,r),R.resolveServer(void 0,t,r,o)}catch{}c&&e?z.write(()=>navigator.clipboard.write([i]),{onSuccess:()=>{console.log(`Successfully wrote image (${r}) from server to local clipboard.`),R.captureLocalImageSig(),window.postMessage({type:`clipboardContentUpdate`,text:`Image (${r}) received from session and copied to clipboard.`},window.location.origin)},onFailure:Sr}):e&&!t&&ee&&Sr(Error(`the local clipboard is unavailable`))}},O.oncursorchange=e=>{k.updateServerCursor(e)},O.ondisplayconfig=e=>{let t=e&&e.displays||[];Ot=e&&e.layouts||null,kt=!!(e&&e.wayland),k&&k.setDisplayLayouts&&k.setDisplayLayouts(Ot,oe),It();let n=t.some(e=>e!==`primary`);rt!==n&&(console.log(`Secondary display connection status changed to: ${n}`),rt=n,Xt())},O.onprintdocument=e=>{tn&&!window.location.hash.startsWith(`#display2`)&&tn.announce(e.name,e.size_bytes)},O.onsystemaction=e=>{if(e.startsWith(`video_declined,`)){let t=e.slice(15).split(`/`).pop().toLowerCase();kn=!0,console.error(`This session streams ${t}, which this browser cannot decode.`),w&&(w.textContent=`Error: This session streams ${ae(t)} video, which this browser cannot decode.`,w.classList.remove(`hidden`));return}if(O._setStatus(`Executing system action: `+e),e===`reload`)setTimeout(()=>{ye.disconnect()},700);else if(e.startsWith(`mk_access,`)){let t=e.slice(10)===`1`;Et=t,k&&(t?k.isInputAttached()||(console.log(`Collab access granted: attaching input context.`),k.attach_context()):(console.log(`Collab access revoked: detaching input context.`),k.detach_context()))}else if(e.startsWith(`command_error,`)&&!B)window.postMessage({type:`fileUpload`,payload:{status:`warning`,fileName:`command`,message:e.slice(14),code:`commandFailed`}},window.location.origin);else if(e.startsWith(`command_done,`)&&!B)window.postMessage({type:`commandDone`,command:e.slice(13)},window.location.origin);else if(e.startsWith(`apps_installed,`)&&!B)window.postMessage({type:`appsInstalled`,apps:JSON.parse(e.slice(15))},window.location.origin);else if(e.startsWith(`auth_success,`)||e.startsWith(`role_update,`)){let t=e.slice(e.indexOf(`,`)+1),n;try{n=JSON.parse(t)}catch(e){console.error(`Failed to parse role verdict:`,e);return}let r=e.startsWith(`role_update,`),i=L;Ue=n.role===P?P:F,L=n.slot===null||n.slot===void 0?null:n.slot,ze=L!==null&&L>0?L-1:void 0,console.log(`Server role verdict: role=${Ue}, slot=${L}`),k&&(k.updateControllerSlot(L),Ue===F&&k.setSharedMode(!0),r&&k.gamepadManager&&(i!==null&&L===null?k.gamepadManager.disable():i===null&&L!==null&&N&&k.gamepadManager.enable())),window.postMessage({type:`clientRoleUpdate`,role:Ue},window.location.origin)}else if(e.startsWith(`capture_demand,`)&&!B){let[t,n]=e.slice(15).split(`,`);t===`webcam`&&!j.has(`webcam`)?n===`1`?Fe||nr(!0):rr():t===`microphone`&&!j.has(`microphone`)&&O&&typeof O.setMicrophone==`function`&&(n===`1`?Pe||tr(!0,!0):tr(!1))}else if(e.startsWith(`resolution,`)){let t=e.slice(11).split(`x`),n=parseInt(t[0],10),r=parseInt(t[1],10);n>0&&r>0&&window.manualResolution&&(T!==n||E!==r)&&(T=n,E=r,Ut(`manual_width`,n),Ut(`manual_height`,r),zn(T,E,le))}else O._setStatus(`Server sent acknowledgment for `+e)},O.onlatencymeasurement=e=>{se=e*2};let be=e=>{if(B||oe!==`primary`)return;let t=t=>e&&e[t]||null,n=(e,n)=>{let r=t(e);return r&&typeof r.value==`boolean`?r.value:n},r=e=>{let n=t(e);return!!(n&&n.value===!1&&n.locked)},i=e=>!j.has(e),a=!1;i(`video`)&&!n(`video_on_start`,!0)&&A&&(A=!1,window.postMessage({type:`pipelineStatusUpdate`,video:!1},window.location.origin),a=!0);let o=n(`audio_enabled`,!0)===!1;i(`audio`)&&!n(`audio_on_start`,!0)&&!o&&Ae&&(Ae=!1,v&&(v.muted=!0),window.postMessage({type:`pipelineStatusUpdate`,audio:!1},window.location.origin),a=!0),i(`microphone`)&&!n(`microphone_on_demand`,!1)&&n(`microphone_on_start`,!1)&&!r(`microphone_enabled`)&&!Me&&O&&typeof O.setMicrophone==`function`&&tr(!0),i(`webcam`)&&!n(`webcam_on_demand`,!1)&&n(`webcam_on_start`,!1)&&!r(`webcam_enabled`)&&nr();let s=window.localStorage.getItem(Rt(`isGamepadEnabled`))!==null;if(i(`gamepad`)&&!s){let e=n(`gamepad_on_start`,!0);N!==e&&(N=e,ir(),a=!0)}a&&er()};O.onserversettings=e=>{if(e.settings===void 0||e.settings===null){console.warn(`Received invalid server settings paylod`);return}console.log(`Received server settings payload:`,e.settings);let t=Mn(e.settings),n=e.settings&&e.settings.video_fullcolor;In=!!(n&&n.locked),n&&G();let r=e.settings&&e.settings.webcam_encoder;if(r&&qt.includes(r.value)){let e=Kt(`webcam_encoder`,r.value);Ie=r.locked||!qt.includes(e)?r.value:e,O&&Ne&&O.setWebcamCodec(Ie).catch(()=>{})}let i=e.settings&&e.settings.command_enabled;_n=i&&typeof i.value==`boolean`?i.value:!0,je||(je=!0,be(e.settings));let a=e.settings&&e.settings.enable_resize;a&&typeof a.value==`boolean`&&(window.enable_resize=a.value);let o=e.settings&&e.settings.clipboard_in_enabled;o&&typeof o.value==`boolean`&&(h=o.value);let s=e.settings&&e.settings.clipboard_out_enabled;s&&typeof s.value==`boolean`&&(ee=s.value);let c=e.settings&&e.settings.enable_binary_clipboard;c&&typeof c.value==`boolean`&&(lt=c.locked?c.value:U(`enable_binary_clipboard`,c.value));let l=rn(e.settings);l!==nt&&(nt=l,Zt());let u=an(e.settings);u!==Qt&&(Qt=u,$t());let d=on(e.settings);if(d!==Oe&&window.postMessage({type:`setUseCssScaling`,value:d},window.location.origin),_r(),window.postMessage({type:`serverSettings`,payload:e.settings},window.location.origin),Object.keys(t).length>0&&(console.log(`Client settings were sanitized by server rules. Sending updates back to server:`,t),or(t,!0)),e.settings.manual_resolution&&e.settings.manual_resolution.value===!0){console.log(`Server settings payload confirms manual mode. Switching to manual resize handlers.`);let t=e.settings.manual_width?parseInt(e.settings.manual_width.value,10):0,n=e.settings.manual_height?parseInt(e.settings.manual_height.value,10):0;t>0&&n>0?(console.log(`Applying server-enforced manual resolution: ${t}x${n}`),window.manualResolution=!0,T=t,E=n,zn(T,E,le),Wn(`server resolution`)&&Un()):console.warn(`Server dictated manual mode but did not provide valid dimensions.`),Yn()}else{if(B){console.log(`Shared mode detected, skipping auto resize enablement.`);return}console.log(`Server settings payload confirms auto mode. Switching to auto resize handlers.`),Jn()}e.settings.enable_webrtc_statistics&&e.settings.enable_webrtc_statistics.value===!0&&(D=!0)},window.isSecureContext&&navigator.clipboard&&(m=`enabled`);let Ce=e=>{O.forceTurn=de,g=k.getWindowResolution(),ye.currRes=g,le===!1&&(O.element.style.width=g[0]+`px`,O.element.style.height=g[1]+`px`),e.iceServers&&e.iceServers.length>1?u(f,Yt(`using TURN servers: `+e.iceServers[1].urls.join(`, `))):u(f,Yt(`no TURN servers found.`)),O.rtcPeerConfig=e,O.connect()};fetch(he()+`/api/turn`,{headers:ht()}).then(function(e){if(!e.ok)throw Error(`Status: ${e.status}`);return e.json()}).then(e=>{Ce(e)}).catch(e=>{u(f,Yt(`TURN config unavailable (${e}); connecting without TURN.`)),console.warn(`Failed to fetch TURN server details (${e}); continuing without TURN.`),Ce({iceServers:[]})})},cleanup(){window.manualResolution=!1,window.fps=0,rr(),window.removeEventListener(`message`,ar),window.removeEventListener(`resize`,Xn),window.removeEventListener(`requestFileUpload`,lr),window.removeEventListener(`focus`,yr),window.removeEventListener(`blur`,br),document.removeEventListener(`visibilitychange`,Dn),yn(),S=null,vr.unwire();try{pt.terminate()}catch(e){if(e.name===`AbortError`)return;console.error(e)}pt=null,e=null,n=8e3,r=60,o=128e3,s=!1,c=!1,d=[],f=[],p=`connecting`,m=`disabled`,g=[],ne=``,ie={gamepadState:`disconnected`,gamepadName:`none`},_={connectionStatType:`unknown`,connectionLatency:0,connectionVideoLatency:0,connectionAudioLatency:0,connectionAudioCodecName:`NA`,connectionAudioBitrate:0,connectionPacketsReceived:0,connectionPacketsLost:0,connectionBytesReceived:0,connectionBytesSent:0,connectionCodec:`unknown`,connectionVideoDecoder:`unknown`,connectionResolution:``,connectionFrameRate:0,connectionVideoBitrate:0,connectionAvailableBandwidth:0},se=0,ce=!1,le=!1,ue=!1,de=!1,C=null,w=null,me=null,ve=500,be=!1,T=0,E=0,N=!0,j.clear(),je=!1,xe=``,Se=!1,Te.disconnected(),Ce=null,Ee!==null&&(clearInterval(Ee),Ee=null),De!==null&&(clearInterval(De),De=null),wn(),O=null,hn=null,k=null,Oe=!1,I=null,ze=0,D=!1,lt=!0,_n=!0,mt.reset()}}}var bn=`/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * What the video wire says about its codec, and the WebCodecs codec string a
 * stream's own key frame declares.
 *
 * A \`0x04\` frame's type byte carries the frame kind in its low nibble (\`1\` = a
 * decode entry point) and the codec id in its high nibble. The codec string a
 * \`VideoDecoder\` is configured with is read from the key frame's parameter sets
 * wherever the codec has them (the H.264 SPS, the H.265 SPS, the AV1 sequence
 * header), so it always matches the bitstream; VP8 has one string, and VP9's
 * level, which its bitstream never carries, is derived from the geometry.
 *
 * Every function here is also injected into the video worker by \`toString()\`,
 * so they reference nothing but each other and stay free of module state.
 */

/** Codec names by wire id. */
export const WIRE_CODECS = { 1: 'h264', 2: 'vp8', 3: 'vp9', 4: 'av1', 5: 'h265' };

/** Encoder wire values and the codec each streams. */
export const ENCODER_CODECS = {
  jpeg: 'jpeg',
  h264enc: 'h264',
  'h264enc-striped': 'h264',
  h265enc: 'h265',
  vp8enc: 'vp8',
  vp9enc: 'vp9',
  av1enc: 'av1',
};

/**
 * @param {number} typeByte The second byte of a video frame's wire header.
 * @returns {string} The codec name; an id no codec has reads as H.264.
 */
export const wireCodecName = (typeByte) => WIRE_CODECS[typeByte >> 4] || 'h264';

/**
 * @param {number} typeByte The second byte of a video frame's wire header.
 * @returns {boolean} Whether the frame is a decode entry point.
 */
export const wireFrameIsKey = (typeByte) => (typeByte & 0x0f) === 0x01;

/**
 * @param {string} encoder An encoder wire value.
 * @returns {string} The codec it streams; an unknown encoder reads as H.264.
 */
export const codecOfEncoder = (encoder) => ENCODER_CODECS[encoder] || 'h264';

/**
 * @param {string} codec A codec name.
 * @returns {boolean} Whether the codec can carry 4:4:4 chroma.
 */
export const codecCarriesFullColor = (codec) => codec === 'h264' || codec === 'h265' || codec === 'vp9';

/**
 * The NAL units of an Annex-B buffer, each without its start code.
 * @param {Uint8Array} bytes
 * @returns {Uint8Array[]}
 */
export const annexbNals = (bytes) => {
  const nals = [];
  const n = bytes.length;
  let start = -1;
  for (let i = 0; i + 2 < n; i++) {
    if (bytes[i] === 0 && bytes[i + 1] === 0 && bytes[i + 2] === 1) {
      if (start >= 0) {
        let end = i;
        while (end > start && bytes[end - 1] === 0) end--;
        if (end > start) nals.push(bytes.subarray(start, end));
      }
      start = i + 3;
      i += 2;
    }
  }
  if (start >= 0 && start < n) nals.push(bytes.subarray(start, n));
  return nals;
};

/**
 * A bit reader over an RBSP: \`bytes\` from \`offset\` with emulation prevention
 * bytes removed, \`limit\` bytes at most.
 * @param {Uint8Array} bytes
 * @param {number} offset
 * @param {number} limit
 * @returns {{u: (n: number) => number, skip: (n: number) => void}}
 */
export const rbspReader = (bytes, offset, limit) => {
  const data = [];
  let zeros = 0;
  for (let i = offset; i < bytes.length && data.length < limit; i++) {
    const b = bytes[i];
    if (zeros >= 2 && b === 3) { zeros = 0; continue; }
    zeros = b === 0 ? zeros + 1 : 0;
    data.push(b);
  }
  let pos = 0;
  const u = (n) => {
    let v = 0;
    for (let i = 0; i < n; i++) {
      const byte = data[pos >> 3];
      const bit = byte === undefined ? 0 : (byte >> (7 - (pos & 7))) & 1;
      v = v * 2 + bit;
      pos++;
    }
    return v;
  };
  return { u, skip: (n) => { pos += n; } };
};

/**
 * \`avc1.PPCCLL\` from the first SPS of an H.264 Annex-B key frame.
 * @param {Uint8Array} bytes
 * @returns {string|null} \`null\` when no SPS is found.
 */
export const parseAvcCodecFromAnnexB = (bytes) => {
  if (!bytes || bytes.length < 5) return null;
  const hex2 = (n) => n.toString(16).toUpperCase().padStart(2, '0');
  for (const nal of annexbNals(bytes)) {
    if ((nal[0] & 0x80) === 0 && (nal[0] & 0x1f) === 7) {
      // profile_idc, constraint flags and level_idc are the first three RBSP
      // bytes and, with profile_idc always >= 66, never need emulation prevention.
      if (nal.length < 4) return null;
      return \`avc1.\${hex2(nal[1])}\${hex2(nal[2])}\${hex2(nal[3])}\`;
    }
  }
  return null;
};

/**
 * \`hev1.P.C.TL.CC\` from the first SPS of an H.265 Annex-B key frame: the
 * general profile, its compatibility flags as the reversed-bit hexadecimal the
 * codecs registration specifies, the tier and level, and the constraint bytes
 * with trailing zero bytes dropped.
 * @param {Uint8Array} bytes
 * @returns {string|null} \`null\` when no SPS is found.
 */
export const parseHevcCodecFromAnnexB = (bytes) => {
  if (!bytes || bytes.length < 5) return null;
  for (const nal of annexbNals(bytes)) {
    if (((nal[0] >> 1) & 0x3f) !== 33 || nal.length < 16) continue;
    const r = rbspReader(nal, 2, 32);
    r.skip(4 + 3 + 1);
    const profileSpace = r.u(2);
    const tier = r.u(1);
    const profile = r.u(5);
    let compat = 0;
    for (let j = 0; j < 32; j++) compat |= r.u(1) << j;
    const constraints = [];
    for (let j = 0; j < 6; j++) constraints.push(r.u(8));
    const level = r.u(8);
    while (constraints.length > 1 && constraints[constraints.length - 1] === 0) constraints.pop();
    const space = ['', 'A', 'B', 'C'][profileSpace];
    const flags = (compat >>> 0).toString(16).toUpperCase();
    const bytesHex = constraints.map((b) => b.toString(16).toUpperCase()).join('.');
    return \`hev1.\${space}\${profile}.\${flags}.\${tier ? 'H' : 'L'}\${level}.\${bytesHex}\`;
  }
  return null;
};

/**
 * \`av01.P.LLT.08\` from the sequence header of an AV1 temporal unit: the profile,
 * the first operating point's level and tier. The encoders here emit 8-bit
 * 4:2:0, which the fixed bit-depth field states.
 * @param {Uint8Array} bytes
 * @returns {string|null} \`null\` when no sequence header is found.
 */
export const parseAv1CodecFromObus = (bytes) => {
  if (!bytes || bytes.length < 2) return null;
  let pos = 0;
  while (pos < bytes.length) {
    const header = bytes[pos];
    const obuType = (header >> 3) & 0x0f;
    const hasExtension = (header & 0x04) !== 0;
    const hasSize = (header & 0x02) !== 0;
    let i = pos + 1 + (hasExtension ? 1 : 0);
    let size = bytes.length - i;
    if (hasSize) {
      size = 0;
      let shift = 0;
      for (;;) {
        if (i >= bytes.length || shift > 28) return null;
        const b = bytes[i++];
        size += (b & 0x7f) * (2 ** shift);
        if ((b & 0x80) === 0) break;
        shift += 7;
      }
    }
    if (obuType === 1) {
      const r = rbspReader(bytes, i, Math.min(size, 64));
      const profile = r.u(3);
      r.skip(1);
      const reduced = r.u(1);
      let level = 0;
      let tier = 0;
      if (reduced) {
        level = r.u(5);
      } else {
        const timingInfo = r.u(1);
        let decoderModel = 0;
        let bufferDelayBits = 0;
        if (timingInfo) {
          r.skip(64);
          if (r.u(1)) {
            let leading = 0;
            while (r.u(1) === 0 && leading < 32) leading++;
            r.skip(leading);
          }
          decoderModel = r.u(1);
          if (decoderModel) {
            bufferDelayBits = r.u(5) + 1;
            r.skip(32 + 5 + 5);
          }
        }
        const displayDelay = r.u(1);
        r.skip(5);
        r.skip(12);
        level = r.u(5);
        tier = level > 7 ? r.u(1) : 0;
        if (decoderModel && r.u(1)) r.skip(bufferDelayBits * 2 + 1);
        if (displayDelay && r.u(1)) r.skip(4);
      }
      return \`av01.\${profile}.\${String(level).padStart(2, '0')}\${tier ? 'H' : 'M'}.08\`;
    }
    pos = i + size;
  }
  return null;
};

/**
 * The VP9 profile a frame's uncompressed header declares.
 * @param {Uint8Array} bytes
 * @returns {number}
 */
export const parseVp9Profile = (bytes) => {
  if (!bytes || bytes.length < 1) return 0;
  const b = bytes[0];
  return ((b >> 5) & 1) | (((b >> 4) & 1) << 1);
};

/**
 * The lowest VP9 level whose luma sample rate and picture size admit a stream,
 * as the two digits of the codec string.
 * @param {number} width
 * @param {number} height
 * @param {number} fps
 * @returns {string}
 */
export const vp9Level = (width, height, fps) => {
  const size = width * height;
  const rate = size * (fps > 0 ? fps : 60);
  const levels = [
    ['10', 829440, 36864], ['11', 2764800, 73728], ['20', 4608000, 122880],
    ['21', 9216000, 245760], ['30', 20736000, 552960], ['31', 36864000, 983040],
    ['40', 83558400, 2228224], ['41', 160432128, 2228224], ['50', 311951360, 8912896],
    ['51', 588251136, 8912896], ['52', 1176502272, 8912896], ['60', 1176502272, 35651584],
    ['61', 2353004544, 35651584], ['62', 4706009088, 35651584],
  ];
  for (const [level, maxRate, maxSize] of levels) {
    if (rate <= maxRate && size <= maxSize) return level;
  }
  return '62';
};

/**
 * The lowest AV1 level admitting a stream, as \`seq_level_idx\`; used only when a
 * key frame's sequence header is unreadable. MaxPicSize is its own Annex A limit,
 * far below the product of the axis maxima, since no level admits a picture that
 * is both its widest and its tallest.
 * @param {number} width
 * @param {number} height
 * @param {number} fps
 * @returns {number}
 */
export const av1LevelIdx = (width, height, fps) => {
  const size = width * height;
  const rate = size * (fps > 0 ? fps : 60);
  const levels = [
    [8, 2359296, 6144, 3456, 70778880], [9, 2359296, 6144, 3456, 141557760],
    [12, 8912896, 8192, 4352, 267386880], [13, 8912896, 8192, 4352, 534773760],
    [14, 8912896, 8192, 4352, 1069547520], [15, 8912896, 8192, 4352, 1069547520],
    [16, 35651584, 16384, 8704, 1069547520], [17, 35651584, 16384, 8704, 2139095040],
    [18, 35651584, 16384, 8704, 4278190080], [19, 35651584, 16384, 8704, 4278190080],
  ];
  for (const [idx, maxSize, maxW, maxH, maxRate] of levels) {
    if (size <= maxSize && width <= maxW && height <= maxH && rate <= maxRate) return idx;
  }
  return 19;
};

/**
 * Pre-stream guess of the H.264 codec string. Decoder creation re-derives the
 * exact codec from the first key frame's SPS, and outside Chromium only a
 * conservative baseline is guessed because Safari rejects a stream whose real
 * profile or level exceeds the configured one.
 * @param {number} width
 * @param {number} height
 * @param {boolean} is444 Whether the stream is 4:4:4 full-color.
 * @param {number} fps
 * @param {boolean} chromium Whether the engine takes a High profile guess.
 * @returns {string}
 */
/**
 * The \`level_idc\`, as a two-hex-digit string, an H.264 stream of this geometry declares, floored
 * across the common frame rates like the encoder's own ladder so a rate change moves nothing.
 * Mirrors \`h264_level\` in pixelflux \`codec.rs\`.
 * @param {number} width
 * @param {number} height
 * @param {number} fps
 * @returns {string}
 */
export const h264LevelIdc = (width, height, fps) => {
  const mbs = Math.ceil(width / 16) * Math.ceil(height / 16);
  const mbps = mbs * Math.max(fps > 0 ? fps : 60, 60);
  const levels = [
    [0x29, 8192, 245760], [0x2A, 8704, 522240], [0x32, 22080, 589824], [0x33, 36864, 983040],
    [0x34, 36864, 2073600], [0x3C, 139264, 4177920], [0x3D, 139264, 8355840], [0x3E, 139264, 16711680],
  ];
  for (const [idc, maxFs, maxMbps] of levels) {
    if (mbs <= maxFs && mbps <= maxMbps) return idc.toString(16).toUpperCase().padStart(2, '0');
  }
  return '3E';
};

export const guessAvcCodec = (width, height, is444, fps, chromium) => {
  if (!chromium) return 'avc1.42E01E';
  // The encoders' emitted profile_idc: High (0x64) for 4:2:0, High 4:4:4 (0xF4) for 4:4:4. The
  // level matches the encoder's per-geometry choice (floored across the common rates), so the
  // decoder configured before the first key frame does not reconfigure when its SPS arrives.
  const profile = is444 ? 'F400' : '6400';
  return \`avc1.\${profile}\${h264LevelIdc(width, height, fps)}\`;
};

/**
 * The WebCodecs codec string of a stream, from its key frame where the codec
 * declares it and from the geometry otherwise.
 * @param {string} codec The wire codec name.
 * @param {Uint8Array|null} keyframe The key frame's payload, or \`null\` for a delta.
 * @param {number} width
 * @param {number} height
 * @param {number} fps
 * @param {boolean} is444
 * @param {boolean} chromium
 * @returns {string}
 */
export const codecStringFor = (codec, keyframe, width, height, fps, is444, chromium) => {
  switch (codec) {
    case 'h265':
      return (keyframe && parseHevcCodecFromAnnexB(keyframe)) ||
        (is444 ? 'hev1.4.10.L153.9E.8' : 'hev1.1.6.L153.B0');
    case 'vp8':
      return 'vp8';
    case 'vp9':
      return \`vp09.0\${keyframe ? parseVp9Profile(keyframe) : 0}.\${vp9Level(width, height, fps)}.08\`;
    case 'av1':
      return (keyframe && parseAv1CodecFromObus(keyframe)) ||
        \`av01.0.\${String(av1LevelIdx(width, height, fps)).padStart(2, '0')}M.08\`;
    default:
      return (keyframe && parseAvcCodecFromAnnexB(keyframe)) ||
        guessAvcCodec(width, height, is444, fps, chromium);
  }
};

/**
 * The color space a decoder is told to assume, which is every session's: no
 * engine reads it out of an H.264 bitstream. Chromium and Firefox both report
 * \`bt709\` at limited range for a stream whose VUI says otherwise, so a full
 * range session rendered without this hint is wrong by up to eight levels a
 * channel, and both honor the hint exactly. VP8 is held to BT.601 whatever the
 * session converted with, the one value its bitstream can name, because Firefox
 * reads that bit and ignores this; VP9 is told BT.709 because Chromium's
 * decoder does not read the matrix from the frame header.
 * @param {string} codec The wire codec name or WebCodecs codec string.
 * @param {boolean} [fullRange] Whether the session converted at full range.
 * @returns {VideoColorSpaceInit}
 */
export const decoderColorSpace = (codec, fullRange = false) => {
  const vp8 = codec === 'vp8';
  const matrix = vp8 ? 'smpte170m' : 'bt709';
  return { primaries: 'bt709', transfer: 'bt709', matrix, fullRange: !vp8 && !!fullRange };
};

/**
 * Representative decoder configurations, one per codec at the profile and
 * level the encoders emit for a 720p stream, for asking an engine what it can
 * decode before any stream exists.
 */
/**
 * A 16x16 Baseline key frame in Annex B form, for asking a decoder whether it
 * takes H.264 without an \`avcC\` description.
 */
export const H264_ANNEXB_SAMPLE = 'AAAAAWdCwArd7ARAAAADAEAAAA8DxIngAAAAAWjOD8gAAAABZYiEOiYoDg==';

/**
 * The \`avcC\` record of an Annex B key frame's SPS and PPS, for a decoder that
 * takes H.264 only with a description; null when either is missing.
 * @param {Uint8Array} bytes
 * @returns {Uint8Array|null}
 */
export const avcDescription = (bytes) => {
  let sps = null;
  let pps = null;
  for (const nal of annexbNals(bytes)) {
    const type = nal[0] & 0x1f;
    if (type === 7 && !sps) sps = nal;
    else if (type === 8 && !pps) pps = nal;
  }
  if (!sps || !pps) return null;
  const out = new Uint8Array(11 + sps.length + pps.length);
  out.set([1, sps[1], sps[2], sps[3], 0xff, 0xe1, sps.length >> 8, sps.length & 0xff], 0);
  out.set(sps, 8);
  out.set([1, pps.length >> 8, pps.length & 0xff], 8 + sps.length);
  out.set(pps, 11 + sps.length);
  return out;
};

/**
 * An Annex B access unit as length-prefixed NAL units, the framing an \`avcC\`
 * description implies, without its parameter sets and delimiters.
 * @param {Uint8Array} bytes
 * @returns {Uint8Array}
 */
export const annexbToAvcc = (bytes) => {
  const nals = annexbNals(bytes).filter((nal) => {
    const type = nal[0] & 0x1f;
    return type !== 7 && type !== 8 && type !== 9;
  });
  let size = 0;
  for (const nal of nals) size += 4 + nal.length;
  const out = new Uint8Array(size);
  let pos = 0;
  for (const nal of nals) {
    out[pos] = nal.length >>> 24;
    out[pos + 1] = (nal.length >>> 16) & 0xff;
    out[pos + 2] = (nal.length >>> 8) & 0xff;
    out[pos + 3] = nal.length & 0xff;
    out.set(nal, pos + 4);
    pos += 4 + nal.length;
  }
  return out;
};

/**
 * @param {Uint8Array|null} a
 * @param {Uint8Array|null} b
 * @returns {boolean} Whether both are absent or byte-for-byte equal.
 */
export const sameBytes = (a, b) => {
  if (!a || !b) return !a && !b;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
};

export const PROBE_CODEC_STRINGS = {
  h264: 'avc1.42E01E',
  h265: 'hev1.1.6.L93.B0',
  vp8: 'vp8',
  vp9: 'vp09.00.31.08',
  av1: 'av01.0.05M.08',
};

/** The 4:4:4 configurations, at the profiles the encoders emit (VP9 profile 1). */
export const PROBE_FULLCOLOR_STRINGS = {
  h264: 'avc1.F4001E',
  h265: 'hev1.4.10.L93.9E.8',
  vp9: 'vp09.01.10.08.03',
};
`,xn=`/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * What a decoder should do with each frame that arrives, so a decoder that
 * falls behind costs the stream as little as possible.
 *
 * A decoder given more than it can decode has to let something go, and what it
 * lets go breaks the frames that predict from it. Where the encoder says what
 * each frame predicts from, the cheapest repair is to drop the frame, tell the
 * server which one went, and hold back only what predicts from it: the encoder
 * predicts past it and decoding resumes on its next frame, no key frame on the
 * wire. Where the encoder says nothing -- a stripe of a striped stream, a codec
 * whose session does not track its references -- the only repair is a key
 * frame, so the gate asks for one instead. A run of drops that the encoder
 * never predicts past is the same case and ends in that request too.
 *
 * @module
 */

/** Frames of decode backlog that count as falling behind. */
export const OVERLOAD_QUEUE = 6;
/** How long that backlog must stand before a frame is let go, in ms. */
export const OVERLOAD_HOLD_MS = 250;
/** How long frames may go undecodable before a key frame is asked for, in ms. */
export const LOST_RECOVERY_MS = 1000;
/** How many dropped frame ids are remembered. A frame predicts from one of the
 * last few its encoder produced, so an older id can never be named again. */
export const LOST_MEMORY = 64;

/**
 * @typedef {'decode'|'lost'|'no_key'|'overload'} Decision What to do with a
 *     frame: decode it, let it go and report it lost, or ask for a key frame
 *     because none has been decoded yet or because dropping more would not help.
 */

export class DecodeGate {
  /**
   * @param {object} [options]
   * @param {() => number} [options.now] Monotonic clock in ms.
   */
  constructor({ now = () => performance.now() } = {}) {
    this._now = now;
    this._lost = [];
    this._lostSince = 0;
    this._overloadSince = 0;
    this._haveKey = false;
    this._needKey = false;
  }

  /** The decoder was (re)built, so it needs a key frame before anything else. */
  configured() {
    this._haveKey = false;
    this._needKey = true;
    this._reset();
  }

  /** Nothing decoded so far is usable, so only a key frame is. */
  invalidated() {
    this._needKey = true;
  }

  _reset() {
    this._lost.length = 0;
    this._lostSince = 0;
    this._overloadSince = 0;
  }

  /**
   * @param {boolean} key Whether the frame decodes on its own.
   * @param {number} frameId The frame's own id.
   * @param {number|undefined} reference The id of the frame it predicts from;
   *     its own id, or undefined, where the encoder does not say.
   * @param {number} queueSize Frames the decoder has yet to decode.
   * @returns {Decision}
   */
  decide(key, frameId, reference, queueSize) {
    if (key) {
      this._haveKey = true;
      this._needKey = false;
      this._reset();
      return 'decode';
    }
    if (!this._haveKey || this._needKey) return 'no_key';
    const tracked = reference !== undefined && reference !== frameId;
    const now = this._now();
    if (tracked && this._lost.includes(reference)) {
      this._remember(frameId);
      if (now - this._lostSince > LOST_RECOVERY_MS) {
        this._needKey = true;
        return 'overload';
      }
      return 'lost';
    }
    if (queueSize > OVERLOAD_QUEUE) {
      if (!this._overloadSince) this._overloadSince = now;
      else if (now - this._overloadSince > OVERLOAD_HOLD_MS) {
        if (!tracked) {
          this._needKey = true;
          return 'overload';
        }
        this._remember(frameId);
        if (!this._lostSince) this._lostSince = now;
        return 'lost';
      }
      return 'decode';
    }
    this._overloadSince = 0;
    this._lostSince = 0;
    return 'decode';
  }

  _remember(frameId) {
    this._lost.push(frameId);
    if (this._lost.length > LOST_MEMORY) this._lost.shift();
  }
}
`;function Sn(e){let t=e||(()=>performance.now()),n=-1/0,r=-1,i=0,a=0,o=()=>i>a?i:a;return{note(e){let o=t();if(e===r){let e=o-n;e>a&&(a=e)}else i=Math.max(a,i*.9),a=0,r=e;n=o},settled:()=>t()-n>=2+o(),waveGapMs:o,settleWaitMs:()=>2+o()}}V(),gt();var Cn=null;Et().then(e=>{Cn=e;try{e&&!isSharedMode&&typeof websocket<`u`&&websocket&&websocket.readyState===WebSocket.OPEN&&websocket.send(`SETTINGS,${JSON.stringify({keyboardLayout:e})}`)}catch{}});var wn=null;function Tn(e,t){let n=e-t>>>0;return n!==0&&n<2147483648}function En(e){let t=new Uint8Array(e),n=t[1];if(!n)return wn=null,[e.slice(2)];if(e.byteLength<6+n*4+1)return wn=null,[];let r=(t[2]<<24|t[3]<<16|t[4]<<8|t[5])>>>0,i=6,a=[],o=[];for(let e=0;e<n;e++){let e=t[i+1]<<16|t[i+2]<<8|t[i+3];a.push(e>>10&16383),o.push(e&1023),i+=4}i+=1;let s=i;for(let e=0;e<n;e++)s+=o[e];if(s>e.byteLength)return wn=null,[];let c=[];for(let t=0;t<n;t++)c.push({ts:r-a[t]>>>0,buf:e.slice(i,i+o[t])}),i+=o[t];if(c.push({ts:r,buf:e.slice(i)}),wn===null)return wn=r,[c[c.length-1].buf];let l=[],u=wn;for(let e of c)Tn(e.ts,u)&&(l.push(e.buf),u=e.ts);return wn=u,l}function Dn(){let e=!1,t=null,o=null,s=null,c=null,l,u=null,d=null,f=null,p=!1,m,h,g,_=1,v;window.currentAudioBufferSize=0,window.currentAudioUnderrunSamples=0,window.currentAudioWorkletDropped=0,window.currentAudioDropped=0;let y=null,b=null,x=null,S=!1,oe=null,ce=0,de=!1,fe=!1,C=0,w=!0,ve=[],be=0,T=!0,E=!0,D=!1,xe=!1,Se,O=-1,Ce=0,we=-1,Te=0,k=0,Ee=0,De=0,Oe=4e3,ke=!1,A=!0,Ae=new Set,j=!1,je=!1,Me=!0,Ne=!0,M=null,Pe=!1,Fe=!1;Object.defineProperty(window,"webcamCodec",{configurable:!0,get:()=>M?M.codec:null});let Ie=`auto`,N=`primary`,Le=`right`,P=[`framerate`,`video_crf`,`video_fullcolor`,`video_streaming_mode`,`jpeg_quality`,`paint_over_jpeg_quality`,`use_cpu`,`video_paintover_crf`,`video_paintover_burst_frames`,`use_paint_over_quality`,`manual_resolution`,`manual_width`,`manual_height`,`encoder`,`scaleLocallyManual`,`use_browser_cursors`,`rate_control_mode`,`video_bitrate`,`force_aligned_resolution`,`scaling_dpi`],F=null,I=null,ze=null,Be=null,Ve=null,Ue=``,L=null,We=null,Ye=null,$e=null,tt=null,rt=null,ot=0,lt=3e3,pt=null,mt=!1,gt=0,_t=0,yt=0,bt=3e3,xt=1e3;window.manual_resolution=!1;let R=null,z=null,wt=null,B=null,Tt={},Et={},Dt=null,V=`h264enc-striped`,H=e=>e!==`jpeg`&&e!==`h264enc-striped`,Ot=e=>e!==`jpeg`,kt=!1,At=!1;function Nt(){return He({useCssScaling:kt,localScale:zt/96,manual:window.manual_resolution,displayId:N,layouts:t,shared:G,wayland:At})}let Pt=0,Ft=0,It=null;function Lt(){let e=Nt();window.webrtcInput&&window.webrtcInput.setStreamDensity&&window.webrtcInput.setStreamDensity(e);let t=Pt>0&&Math.abs(e-Pt)>1e-6;Pt=e,t&&N!==`primary`&&!window.manual_resolution&&B&&(console.log(`Stream density changed: ${e}.`),B())}let Rt=!1,zt=96;function Bt(){return window.manual_resolution?Ke(R,z):Ge()}function Ut(){return kt&&!window.manual_resolution?96:zt}function U(e){if(G||Fr(`scaling_dpi`,null)!==null)return!1;let t=Bt();return t!==zt&&(zt=t,console.log(`DPI follows ${e}: scaling_dpi -> ${t}.`),window.postMessage({type:`scalingDpiFollowed`,value:t},window.location.origin),!0)}let Gt=window.devicePixelRatio||1;function Kt(){let e=window.devicePixelRatio||1;e!==Gt&&(Gt=e,U(`devicePixelRatio changed`)&&aa(`devicePixelRatio changed`))}let Jt=!0,Yt=!0,W=!0,Xt=!0,Zt=!0;function Qt(){let t=Zt,n=N===`display2`||N===`primary`&&e,r=n?!0:t;window.webrtcInput&&typeof window.webrtcInput.setUseBrowserCursors==`function`&&(console.log(`Applying effective cursor setting. Multi-monitor: ${n}, User Pref: ${t}, Final: ${r}`),window.webrtcInput.setUseBrowserCursors(r));try{window.postMessage({type:`effectiveCursorState`,value:r},window.location.origin)}catch{}}let $t=!0;function en(){window.webrtcInput&&typeof window.webrtcInput.setRawPointerMotion==`function`&&window.webrtcInput.setRawPointerMotion($t)}let tn=!0;function nn(){window.webrtcInput&&typeof window.webrtcInput.setMacCmdAsCtrl==`function`&&window.webrtcInput.setMacCmdAsCtrl(tn)}let rn=!0;function an(){window.webrtcInput&&typeof window.webrtcInput.setShortcutsEnabled==`function`&&window.webrtcInput.setShortcutsEnabled(rn)}function ln(){let e=window.innerHeight*.01;document.documentElement.style.setProperty(`--vh`,`${e}px`)}let dn=0,pn=new St,mn=e=>pn.reencodePng(e).then(e=>e.result),hn=!0,gn=(()=>{let e=/iPad|iPhone|iPod/.test(navigator.userAgent)||navigator.platform===`MacIntel`&&navigator.maxTouchPoints>1,t=/Firefox|FxiOS/.test(navigator.userAgent),n=/CriOS/.test(navigator.userAgent),r=(navigator.userAgentData&&navigator.userAgentData.brands||[]).some(e=>/Chromium|Google Chrome/.test(e.brand)),i=window.chrome!==void 0;return(r||i)&&!e&&!t&&!n})(),_n=dt({isChromium:gn,canRead:()=>!!Yt,sendRequest:()=>{l&&l.readyState===WebSocket.OPEN&&l.send(`REQUEST_CLIPBOARD`)},digestBytes:async e=>{let{byteLength:t,hash:n}=await pn.hashBytes(e);return Je(t,n)}}),vn=ct(),yn=it(e=>pn.decodeStream(e)),wn=at(),Tn=()=>wn.arm(),Dn=()=>wn.consume(),On=null;function kn(e,t,n){return On?On.sendExplicit(e,t,n):(n&&n(`not connected`,`clipboardSkipNotConnected`),Promise.resolve())}let An=null,jn=0,Mn=new URLSearchParams(window.location.search),Nn=Mn.get(`token`),Pn=window.location.hash;if(Pn.startsWith(`#display2`)){N=`display2`;let e=Pn.split(`-`);if(e.length>1){let t=e[1];[`left`,`right`,`up`,`down`].includes(t)&&(Le=t)}}Nn?(p=!0,console.log(`Client is running in Token Authentication mode.`)):Pn===`#shared`?(An=`shared`,jn=void 0):Pn===`#player2`?(An=`player2`,jn=1):Pn===`#player3`?(An=`player3`,jn=2):Pn===`#player4`&&(An=`player4`,jn=3);let Fn=`idle`,In=!1,G=An!==null,Ln=!0;G&&console.log(`Client is running in ${An} mode.`),N===`display2`&&console.log(`Client is running in Secondary Display mode.`),window.onload=()=>{};let Rn=ge(),zn=(e,t)=>{try{window.localStorage.setItem(e,t)}catch(t){console.warn(`Selkies: could not persist '${e}' to localStorage:`,t)}},Bn=`${Rn}_prefer_software_decode`,Vn=!1;try{Vn=window.localStorage.getItem(Bn)===navigator.userAgent}catch(e){console.warn(`Selkies: could not read the software-decode preference:`,e)}let Hn=Vn,Un=-1/0,Wn=3e3,Gn=!1,Kn=e=>{let t=!!(e&&e.full_range);if(t!==Gn&&(Gn=t,Q))try{Q.postMessage({type:`wireHints`,fullRange:t})}catch{}},qn=e=>{if(Q)try{Q.postMessage({type:`wireHints`,software:e})}catch{}if(Vn=e,e){zn(Bn,navigator.userAgent);return}try{window.localStorage.removeItem(Bn)}catch(e){console.warn(`Selkies: could not clear the software-decode preference:`,e)}},Jn=e=>Vn?{...e,hardwareAcceleration:`prefer-software`}:e,Yn=`${Rn}_crash_count`,Xn=!1,Zn=()=>{if(!(Xn||G)&&!(!(window.fps>0)||performance.now()<6e4)){Xn=!0;try{window.localStorage.removeItem(Yn)}catch(e){console.warn(`Selkies: could not clear the decoder crash count:`,e)}}};function Qn(){let e=Hn&&performance.now()-Un<Wn;if(G||window.isFallingBack||e||Gi||!T||V===`jpeg`||typeof VideoDecoder>`u`){De=0;return}let t=performance.now(),n=t-Ee<Oe,r=Ee-k>Oe;if(!n||!r){De=0;return}if(De===0){De=t;return}t-De>=Oe&&(De=0,Fo(Error(`decoder produced no output while chunks arrived`),`no_output`))}document.title=`Selkies`,fetch(`manifest.json`).then(e=>e.json()).then(e=>{e.name&&(document.title=e.name)}).catch(()=>{});let $n=60,er=25,tr=!1,nr=!1,rr=60,ir=90,ar=!1,or=18,sr=5,cr=!0,lr=32e4,ur=8e3,dr=!1,fr=`connecting`,pr=``,mr=null,K={starts:new Map,decodeMs:0,frames:0,format:void 0,hardware:null,probed:``,config:null};function hr(e){K.format=e.format;let t=K.starts.get(e.timestamp);t!==void 0&&(K.starts.delete(e.timestamp),K.decodeMs+=performance.now()-t,K.frames++)}function gr(e){let t=`${e.codec}:${e.codedWidth}x${e.codedHeight}`;t!==K.probed&&(K.probed=t,K.hardware=null,VideoDecoder.isConfigSupported({...e,hardwareAcceleration:`prefer-hardware`}).then(e=>{K.probed===t&&(K.hardware=!!e.supported)}).catch(()=>{}))}let _r=null,vr=new fn({transport:`websockets`,send:e=>{if(l&&l.readyState===WebSocket.OPEN)l.send(e);else throw Error(`not connected`)},isViewer:()=>G||d===`viewer`,onOpenChange:e=>{if(mr=null,K.starts.clear(),K.decodeMs=0,K.frames=0,Q)try{Q.postMessage({type:`statsOpen`,open:e})}catch{}_r!==null&&clearInterval(_r),_r=e?setInterval(yr,1e3):null}});function yr(){let e=mr&&(mr.frames>0||mr.bytes>0),t=e?mr:{...K};mr=null,K.decodeMs=0,K.frames=0,K.starts.size>64&&K.starts.clear(),t.bytes&&vr.noteBytes(t.bytes),vr.setClient(Object.assign({codec:i(V)||V,resolution:s&&s.width>0?`${s.width}x${s.height}`:``,sink:Ue.split(/ \u2014 |; /)[0].replace(/\.$/,``),decode_path:V===`jpeg`?Ei():``},un({forcedSoftware:Vn,hardwareSupported:t.hardware,format:V===`jpeg`?void 0:t.format}))),!e&&K.config&&gr(K.config);let n={fps:window.fps};E&&(n.audio_buffer_ms=Math.round(window.currentAudioBufferDuration||0)),D&&(n.mic=`Opus, 32 kbps`),xe&&M&&(n.webcam=`${String(M.codec||``).toUpperCase()} ${M.width}x${M.height} at ${M.fps} fps`),t.frames>0&&(n.decode_ms=Math.round(t.decodeMs/t.frames*100)/100),vr.clientSample(n)}let br=!1,xr=!1,Sr=null,Cr=!1,wr;window.fps=0,window.videoChunksReceived=0,window.videoDivertOn=!1,window.videoStripeRows={};let Tr=0,Er=new Set,Dr=performance.now(),Or=performance.now(),q,kr,J,Ar=`crf`,Y=(e,t)=>{let n=`${Rn}_${e}`,r=n;N===`display2`&&P.includes(e)&&(r=`${n}_${N}`);let i=window.localStorage.getItem(r);return i==null?t:parseInt(i)},jr=(e,t)=>{let n=`${Rn}_${e}`,r=n;N===`display2`&&P.includes(e)&&(r=`${n}_${N}`);let i=window.localStorage.getItem(r),a=parseFloat(i);return i==null||isNaN(a)?t:a},Mr=(e,t)=>{let n=`${Rn}_${e}`,r=n;N===`display2`&&P.includes(e)&&(r=`${n}_${N}`),t==null?window.localStorage.removeItem(r):zn(r,t.toString())},Nr=e=>{let t=`${Rn}_${e}`;return N===`display2`&&P.includes(e)?`${t}_${N}`:t},X=(e,t)=>{let n=`${Rn}_${e}`,r=n;N===`display2`&&P.includes(e)&&(r=`${n}_${N}`);let i=window.localStorage.getItem(r);return i===null?t:i.toString().toLowerCase()===`true`},Pr=(e,t)=>{let n=`${Rn}_${e}`,r=n;N===`display2`&&P.includes(e)&&(r=`${n}_${N}`),t==null?window.localStorage.removeItem(r):zn(r,t.toString())},Fr=(e,t)=>{let n=`${Rn}_${e}`,r=n;return N===`display2`&&P.includes(e)&&(r=`${n}_${N}`),window.localStorage.getItem(r)??t},Ir=(e,t)=>{let n=`${Rn}_${e}`,r=n;N===`display2`&&P.includes(e)&&(r=`${n}_${N}`),t==null?window.localStorage.removeItem(r):zn(r,t.toString())};function Lr(e){let t=Nr(`useCssScaling`),n=window.localStorage.getItem(`${t}_explicit_choice`)===`true`,r=jt(Mt,e,{manualActive:!!window.manual_resolution||R>0},()=>n?window.localStorage.getItem(t):null);return Mt.toServer(r)}function Rr(e){return jt(Vt,e,{macDesktop:_e()},e=>Fr(e,null))}function zr(e){return jt(Ht,e,{macDesktop:_e()},e=>Fr(e,null))}function Br(e){console.log(`Sanitizing and storing settings based on server payload.`);let t={},n=e=>{let t=`${Rn}_${e}`;return N===`display2`&&P.includes(e)?`${t}_${N}`:t};for(let r in e){if(!e.hasOwnProperty(r))continue;let i=e[r],a=Wt(r),o=n(a),s=window.localStorage.getItem(o)===null;if(i.min!==void 0&&i.max!==void 0){let e=jr(a,i.default);s?window[r]=e:e<i.min||e>i.max?(console.log(`Sanitizing '${r}': stored value ${e} out of range [${i.min}-${i.max}]. Reverting to server default ${i.default}.`),window.localStorage.removeItem(o),window[r]=i.default,t[r]=i.default):window[r]=e}else if(i.allowed!==void 0){let e=!isNaN(parseFloat(i.allowed[0])),n=e?Y(a,parseInt(i.value,10)).toString():Fr(a,i.value),c=t=>{window[r]=e?parseInt(t,10):t};s?c(i.value):i.allowed.includes(n)?(c(n),e?Mr(a,parseInt(n,10)):Ir(a,n)):(console.log(`Sanitizing '${r}': stored "${n}" not in allowed [${i.allowed.join(`, `)}]. Reverting to server default "${i.value}".`),window.localStorage.removeItem(o),c(i.value),t[r]=i.value)}else if(typeof i.value==`boolean`){let e=i.value;if(i.locked){let n=X(a,!e);n!==e&&(console.log(`Sanitizing '${r}': setting is locked by server. Client value ${n} is being overwritten with ${e}.`),t[r]=e),window[r]=e}else if(s)window[r]=e,i.overridden&&(t[r]=e);else{let t=X(a,e);window[r]=t,Pr(a,t)}}else i.value!==void 0&&(window[r]=i.value)}return t}$n=Y(`framerate`,$n),er=Y(`video_crf`,er),tr=X(`video_fullcolor`,tr),nr=X(`video_streaming_mode`,nr),rr=Y(`jpeg_quality`,rr),ir=Y(`paint_over_jpeg_quality`,ir),ar=X(`use_cpu`,ar),or=Y(`video_paintover_crf`,or),sr=Y(`video_paintover_burst_frames`,sr),cr=X(`use_paint_over_quality`,cr),lr=Y(`audio_bitrate`,lr),br=X(`debug`,br),V=Fr(`encoder`,`h264enc`),Ie=Fr(`webcam_encoder`,`auto`),wr=X(`scaleLocallyManual`,!0),window.manual_resolution=X(`manual_resolution`,!1),Se=X(`isGamepadEnabled`,!0),kt=X(`useCssScaling`,!1),Rt=X(`trackpadMode`,!1),Ar=Fr(`rate_control_mode`,Ar),ur=Y(`video_bitrate`,ur),Jt=X(`antiAliasingEnabled`,!0),Zt=X(`use_browser_cursors`,!0),$t=X(`raw_pointer_motion`,Re.rawPointerMotion),hn=X(`enable_binary_clipboard`,hn),Yt=X(`clipboard_in_enabled`,!0),Xt=X(`clipboard_seamless`,!0),rn=X(`keyboard_shortcuts`,!0),W=X(`clipboard_out_enabled`,!0);let Vr=cn({automatic:X(`print_auto`,!0)});dr=X(`force_aligned_resolution`,dr),G?(R=1280,z=720,console.log(`Shared mode: Initialized manual_width/Height to ${R}x${z}`)):(R=Y(`manual_width`,null),z=Y(`manual_height`,null)),zt=Fr(`scaling_dpi`,null)===null?Bt():Y(`scaling_dpi`,96);let Hr=!1,Ur=e=>{Hr=!!e;let t=window.webrtcInput;t&&e&&typeof t.enterGamingMode==`function`?t.enterGamingMode():t&&typeof t.enterFullscreen==`function`?t.enterFullscreen():document.fullscreenElement===null&&document.documentElement.requestFullscreen().catch(()=>{})},Wr=()=>{kr&&kr.classList.add(`hidden`),q&&q.classList.add(`hidden`),Qa(),console.log(`playStream called in WebSocket mode - UI elements hidden.`)},Gr=()=>{if(q){let e=pr||fr;q.textContent=e&&e.charAt(0).toUpperCase()+e.slice(1)}};window.applyTimestamp=e=>{let t=new Date;return`[${`${t.getHours()}:${t.getMinutes()}:${t.getSeconds()}`}] ${e}`};let Z=e=>{let t=dr?16:2;return Math.floor(e/t)*t},Kr=typeof MediaStreamTrackGenerator<`u`,qr=!1,Q=null,$=null,Jr=!0,Yr=!1,Xr=!1,Zr=null,Qr=null,$r=!1,ei=null,ti=0,ni=!1,ri=null,ii=0,ai=0,oi=null,si=!1,ci=!1,li=!1,ui=0,di=!1,fi=!1,pi=0,mi=!1,hi=0;function gi(){if(!(Zr===`canvas`&&fe&&$&&s&&s.width>=640&&$.width<640)){hi=0;return}let e=performance.now();if(!hi){hi=e;return}e-hi>1500&&(mi=!0,console.info(`[Selkies] worker canvas placeholder never took a committed frame; presenting on the page canvas instead.`),ki())}let _i=`
${xn.replace(/^export /gm,``)}
// Video sink and optional in-worker decoder. The sink is a worker-only
// VideoTrackGenerator (its track transferred to the page for <video>.srcObject) or a
// transferred OffscreenCanvas. Encoded chunks are decoded here so no decoded frame
// crosses the thread boundary; a frame transferred in (m.frame) is the warm-up path.
let mode = null, oc = null, ctx = null, writer = null, closed = false, presented = false;
let dec = null;
const gate = new DecodeGate();
// Decode figures, gathered and posted once a second only while the page has its stats open.
let statsTimer = null, statsBytes = 0, statsDecodeMs = 0, statsFrames = 0;
let statsFormat, statsHardware = null, statsProbed = null, statsConfig = null;
const decodeStarts = new Map();
function noteDecoded(f) {
  const started = decodeStarts.get(f.timestamp);
  if (started === undefined) return;
  decodeStarts.delete(f.timestamp);
  statsDecodeMs += performance.now() - started;
  statsFrames++;
}
// Whether the engine has a hardware decoder for the configured stream, asked once per configuration.
function probeHardware(codec, w, h) {
  const probed = codec + ':' + w + 'x' + h;
  if (probed === statsProbed || typeof VideoDecoder === 'undefined') return;
  statsProbed = probed;
  statsHardware = null;
  VideoDecoder.isConfigSupported({ codec: codec, codedWidth: w, codedHeight: h, hardwareAcceleration: 'prefer-hardware' })
    .then((r) => { if (statsProbed === probed) statsHardware = !!r.supported; })
    .catch(() => {});
}
function setStatsOpen(open) {
  if (statsTimer) { clearInterval(statsTimer); statsTimer = null; }
  decodeStarts.clear();
  statsBytes = 0; statsDecodeMs = 0; statsFrames = 0;
  if (!open) return;
  statsTimer = setInterval(() => {
    if (statsConfig) probeHardware(statsConfig.codec, statsConfig.w, statsConfig.h);
    self.postMessage({ type: 'decodeStats', bytes: statsBytes, decodeMs: statsDecodeMs, frames: statsFrames,
      format: statsFormat, hardware: statsHardware });
    statsBytes = 0; statsDecodeMs = 0; statsFrames = 0;
    if (decodeStarts.size > 64) decodeStarts.clear();
  }, 1000);
}
// Consecutive backpressure drops; a stalled consumer never resumes on its own.
let sinkDrops = 0;
// Keyframe-request throttle while decode is backed up.
let lastNeedKey = 0;
const sendNeedKey = (reason) => {
  const now = Date.now();
  if (now - lastNeedKey < 800) return;
  lastNeedKey = now;
  self.postMessage({ type: 'needKeyframe', reason });
};
const ack = () => self.postMessage({ ack: true });

// Present one decoded VideoFrame on the active sink. Consumes/closes the frame.
function present(f) {
  presentedFrames++;
  if (statsTimer) noteDecoded(f);
  if (mode === 'vtg' && writer && !closed) {
    // Drop on sink backpressure.
    if (writer.desiredSize !== null && writer.desiredSize <= 0) {
      f.close();
      if (++sinkDrops >= 30) { closed = true; self.postMessage({ type: 'error' }); }
      return;
    }
    sinkDrops = 0;
    // write() consumes/closes f on success; on reject (writable errored) it does NOT, so close it here to avoid leaking the frame.
    writer.write(f).catch(() => { try { f.close(); } catch (_) {} closed = true; self.postMessage({ type: 'error' }); });
    return;
  }
  try {
    if (ctx) {
      if (oc.width !== f.displayWidth || oc.height !== f.displayHeight) { oc.width = f.displayWidth; oc.height = f.displayHeight; }
      ctx.drawImage(f, 0, 0);
      // Tell the page the OffscreenCanvas has real content so it can hide the
      // main canvas (hiding it before this point flashes black).
      if (!presented) { presented = true; self.postMessage({ type: 'presented' }); }
    }
  } finally { f.close(); }
}

function closeDecoder() {
  if (dec) { try { if (dec.state !== 'closed') dec.close(); } catch (_) {} dec = null; }
  gate.configured();
  wireCodec = null; wireW = 0; wireH = 0; wireDesc = null;
}

function configureDecoder(codec, w, h, software, description) {
  closeDecoder();
  try {
    dec = new VideoDecoder({ output: (f) => { statsFormat = f.format; present(f); },
                             error: () => { closeDecoder(); self.postMessage({ type: 'decoderError' }); } });
    // configure() is synchronous, so the next chunk decodes without an async gap and
    // an unsupported config surfaces via error(). The page owns the acceleration
    // preference; unset, the UA default takes a hardware decoder where there is one,
    // and the pinned SPS level keeps it from re-initializing mid-stream.
    const cfg = { codec: codec, codedWidth: w, codedHeight: h, optimizeForLatency: true };
    if (software) cfg.hardwareAcceleration = 'prefer-software';
    if (description) cfg.description = description;
    cfg.colorSpace = decoderColorSpace(codec, wireFullRange);
    dec.configure(cfg);
    statsConfig = { codec: codec, w: w, h: h };
    // A keyframe is required after (re)configure.
    gate.configured();
    return true;
  } catch (err) { closeDecoder(); self.postMessage({ type: 'decoderError' }); return false; }
}

// frameId and reference come off the wire header; a frame that names itself
// predicts from nothing the encoder can say (DecodeGate).
function decodeChunk(key, data, timestamp, frameId, reference) {
  if (!dec || dec.state !== 'configured') return;
  const decision = gate.decide(key, frameId, reference, dec.decodeQueueSize);
  if (decision === 'lost') { self.postMessage({ type: 'lostFrame', id: frameId }); return; }
  if (decision !== 'decode') { sendNeedKey(decision); return; }
  if (statsTimer) decodeStarts.set(timestamp, performance.now());
  try { dec.decode(new EncodedVideoChunk({ type: key ? 'key' : 'delta', timestamp: timestamp, data: data })); }
  catch (err) { closeDecoder(); self.postMessage({ type: 'decoderError' }); }
}

// Raw stripes routed straight from the socket worker, so decode and
// presentation never touch the page. The header is parsed here and the codec
// is derived from each keyframe's SPS; hints carry the page's fallback guess
// and acceleration preference. Wire stats go up once a second for the page's
// counters, watchdogs and fps, with the row layout this side is decoding.
let wireCodec = null, wireW = 0, wireH = 0, wireHint = null, wireSoftware = false, wireChromium = false;
// The range the session converted at, and the one each decoder was configured
// with: a decoder outlives the report that names the range, so a change has to
// reach it as a reconfigure rather than only the next configure.
let wireFullRange = false, wireRange = false;
// H.264 as this engine takes it: Annex B as sent, or length-prefixed NAL units
// behind the key frame's avcC description where Annex B is refused.
let wireAvcc = false, wireDesc = null;
const avcFramed = (codec) => wireAvcc && typeof codec === 'string' && codec.startsWith('avc1');
// The codec the page's encoder streams; frames of another are the stream it
// just left, still in flight, and must not build (and lose) a decoder here.
let wireExpect = null;
let wireChunks = 0, wireFrames = 0, wireLastId = -1, wireStatsTimer = null;
// The codec helpers by source: a bundler renames the module bindings they
// share, which a stringified function would carry in here unresolved.
${bn.replace(/^export /gm,``)}

// The striped modes (h264enc-striped, jpeg) decode, composite and present in
// here: a VideoDecoder per row offset or an in-worker JPEG decode, drawn onto
// a persistent back-buffer so undamaged rows survive, presented by the page's
// rule -- last row landed, or the socket and decoders proven quiet (the
// stripe clock), else at the frame-id boundary -- with the presented id going
// back over the wire port so the server paces against what reached the screen.
const createStripeClock = ${Sn.toString()};
const STRIPE_DECODE_QUEUE_LIMIT = 8;
const JPEG_STRIPE_REORDER_WINDOW = 256;
let stripedOn = false, wirePort = null;
let stripeDecs = {}, jpegLastRowId = {}, jpegRowHeights = {}, jpegPending = 0;
let stripeBack = null, stripeBackCtx = null;
let stripeGeomW = 0, stripeGeomH = 0, stripeGeomKnown = false;
let stripePendingId = null, stripeDirty = false, stripeBottom = false;
let stripeSoftErrors = 0, stripeSoftWindowStart = 0, settleTimer = null;
let presentedFrames = 0, wireDimsW = 0, wireDimsH = 0;
const stripeClock = createStripeClock();

function closeStripeState() {
  for (const y in stripeDecs) {
    const info = stripeDecs[y];
    try { if (info.dec.state !== 'closed') info.dec.close(); } catch (err) {}
  }
  stripeDecs = {}; jpegLastRowId = {}; jpegRowHeights = {}; jpegPending = 0;
  stripePendingId = null; stripeDirty = false; stripeBottom = false;
  if (settleTimer) { clearTimeout(settleTimer); settleTimer = null; }
}

// Grows to cover every stripe seen; an explicit geometry change rebuilds it.
function stripeEnsureBack(minW, minH) {
  const w = Math.max(stripeGeomW, minW), h = Math.max(stripeGeomH, minH);
  if (!(w > 0) || !(h > 0)) return false;
  if (!stripeBack) {
    stripeBack = new OffscreenCanvas(w, h);
    stripeBackCtx = stripeBack.getContext('2d', { desynchronized: true, alpha: false });
  } else if (stripeBack.width < w || stripeBack.height < h) {
    const old = stripeBack;
    stripeBack = new OffscreenCanvas(Math.max(old.width, w), Math.max(old.height, h));
    stripeBackCtx = stripeBack.getContext('2d', { desynchronized: true, alpha: false });
    try { stripeBackCtx.drawImage(old, 0, 0); } catch (err) {}
  }
  return true;
}

function stripeDrained() {
  if (jpegPending > 0) return false;
  for (const y in stripeDecs) { if (stripeDecs[y].meta.length > 0) return false; }
  return true;
}

function stripePresent() {
  if (!stripeBack || !stripeDirty) return;
  stripeDirty = false; stripeBottom = false;
  presentedFrames++;
  if (stripePendingId !== null && wirePort) {
    try { wirePort.postMessage({ presentedId: stripePendingId }); } catch (err) {}
  }
  // A shared viewer learns striped geometry from the composite itself.
  if (!stripeGeomKnown && (stripeBack.width !== wireDimsW || stripeBack.height !== wireDimsH)) {
    wireDimsW = stripeBack.width; wireDimsH = stripeBack.height;
    self.postMessage({ type: 'wireDims', w: wireDimsW, h: wireDimsH });
  }
  if (mode === 'vtg' && writer && !closed) {
    let f = null;
    try { f = new VideoFrame(stripeBack, { timestamp: performance.now() * 1000 }); }
    catch (err) { return; }
    present(f);
    return;
  }
  if (ctx) {
    if (oc.width !== stripeBack.width || oc.height !== stripeBack.height) {
      oc.width = stripeBack.width; oc.height = stripeBack.height;
    }
    try { ctx.drawImage(stripeBack, 0, 0); } catch (err) {}
    if (!presented) { presented = true; self.postMessage({ type: 'presented' }); }
  }
}

function stripeScheduleSettle() {
  if (settleTimer) return;
  const wait = Math.max(1, Math.ceil(stripeClock.settleWaitMs()));
  settleTimer = setTimeout(() => {
    settleTimer = null;
    if (!stripeDirty) return;
    if (stripeDrained() && stripeClock.settled()) { stripePresent(); return; }
    stripeScheduleSettle();
  }, wait);
}

// A new frame id proves the previous frame complete, so it goes up first
// unless quiet already presented it.
function stripeBoundary(frameId) {
  if (stripePendingId !== null && frameId !== stripePendingId && stripeDirty &&
      !(stripeDrained() && stripeClock.settled())) {
    stripePresent();
  }
  stripePendingId = frameId;
}

function stripeMaybePresent() {
  if (!stripeDirty) return;
  if (stripeDrained() && (stripeBottom || stripeClock.settled())) { stripePresent(); return; }
  stripeScheduleSettle();
}

// Draws one decoded stripe at its row offset; always consumes the image.
function stripeCompose(image, y, h, frameId) {
  const w = image.displayWidth !== undefined ? image.displayWidth : image.width;
  if (!stripeEnsureBack(w, y + h)) { try { image.close(); } catch (err) {} return; }
  stripeBoundary(frameId);
  try { stripeBackCtx.drawImage(image, 0, y); stripeDirty = true; } catch (err) {}
  try { image.close(); } catch (err) {}
  if (stripeGeomKnown && y + h >= stripeGeomH) stripeBottom = true;
  stripeMaybePresent();
}

function onStripeError(y) {
  const info = stripeDecs[y];
  if (info) {
    try { if (info.dec.state !== 'closed') info.dec.close(); } catch (err) {}
    delete stripeDecs[y];
  }
  const now = Date.now();
  if (now - stripeSoftWindowStart > 10000) { stripeSoftWindowStart = now; stripeSoftErrors = 0; }
  // A burst of failures says decode should leave the worker for the page ladder.
  if (++stripeSoftErrors > 12) { self.postMessage({ type: 'decoderError' }); return; }
  sendNeedKey('stripe_error');
}

function onH264Stripe(buffer) {
  if (buffer.byteLength < 13) return;
  const head = new Uint8Array(buffer, 0, 12);
  const key = wireFrameIsKey(head[1]);
  const frameId = (head[2] << 8) | head[3];
  const y = (head[4] << 8) | head[5];
  const w = (head[6] << 8) | head[7];
  const h = (head[8] << 8) | head[9];
  wireChunks++;
  if (frameId !== wireLastId) { wireFrames++; wireLastId = frameId; }
  stripeClock.note(frameId);
  const payload = buffer.slice(12);
  if (payload.byteLength === 0) return;
  let info = stripeDecs[y];
  let codec = info ? info.codec : null;
  const bytes = new Uint8Array(payload);
  if (key) codec = codecStringFor(wireCodecName(head[1]), bytes, w, h, 0, false, wireChromium);
  else if (!codec) codec = wireHint;
  if (!codec) { sendNeedKey('no_codec'); return; }
  const framed = avcFramed(codec);
  const desc = key && framed ? avcDescription(bytes) : (info ? info.desc : null);
  if (!info || info.dec.state !== 'configured' || info.w !== w || info.h !== h || info.codec !== codec
      || info.range !== wireFullRange || (key && framed && !sameBytes(desc, info.desc))) {
    // Only a keyframe may (re)configure a row: deltas against a lost state are noise.
    if (!key) { sendNeedKey('no_key'); return; }
    if (info) { try { if (info.dec.state !== 'closed') info.dec.close(); } catch (err) {} }
    const rowY = y;
    const dec = new VideoDecoder({
      output: (f) => {
        // The row decoder's own frame says what made it; the composite it joins is canvas-backed.
        statsFormat = f.format;
        const rowInfo = stripeDecs[rowY];
        const meta = rowInfo && rowInfo.meta.length ? rowInfo.meta.shift() : null;
        stripeCompose(f, rowY, f.displayHeight, meta ? meta.frameId : wireLastId);
      },
      error: () => onStripeError(rowY),
    });
    try {
      const cfg = { codec: codec, codedWidth: w, codedHeight: h, optimizeForLatency: true };
      if (wireSoftware) cfg.hardwareAcceleration = 'prefer-software';
      if (desc) cfg.description = desc;
      cfg.colorSpace = decoderColorSpace(codec, wireFullRange);
      dec.configure(cfg);
    } catch (err) {
      try { if (dec.state !== 'closed') dec.close(); } catch (e2) {}
      onStripeError(y);
      return;
    }
    info = stripeDecs[y] = { dec: dec, w: w, h: h, codec: codec, desc: desc,
                             range: wireFullRange, gotKey: false, meta: [] };
    statsConfig = { codec: codec, w: w, h: h };
  }
  if (!key && !info.gotKey) { sendNeedKey('no_key'); return; }
  if (!key && info.dec.decodeQueueSize > STRIPE_DECODE_QUEUE_LIMIT) {
    // Deltas behind a backlog only deepen it; the row is gated until its next IDR.
    info.gotKey = false;
    sendNeedKey('overload');
    return;
  }
  try {
    info.meta.push({ frameId: frameId });
    const data = framed ? annexbToAvcc(bytes) : payload;
    info.dec.decode(new EncodedVideoChunk({ type: key ? 'key' : 'delta', timestamp: performance.now() * 1000, data: data }));
    if (key) info.gotKey = true;
  } catch (err) {
    info.meta.pop();
    onStripeError(y);
  }
}

function onJpegStripe(buffer) {
  if (buffer.byteLength < 7) return;
  const head = new Uint8Array(buffer, 0, 6);
  const frameId = (head[2] << 8) | head[3];
  const y = (head[4] << 8) | head[5];
  wireChunks++;
  if (frameId !== wireLastId) { wireFrames++; wireLastId = frameId; }
  stripeClock.note(frameId);
  const data = buffer.slice(6);
  if (data.byteLength === 0) return;
  const done = (image) => {
    jpegPending--;
    if (!image) { stripeMaybePresent(); return; }
    const last = jpegLastRowId[y];
    if (last !== undefined) {
      const behindBy = (last - frameId) & 0xFFFF;
      if (behindBy > 0 && behindBy <= JPEG_STRIPE_REORDER_WINDOW) {
        try { image.close(); } catch (err) {}
        stripeMaybePresent();
        return;
      }
    }
    jpegLastRowId[y] = frameId;
    const h = image.displayHeight !== undefined ? image.displayHeight : image.height;
    jpegRowHeights[y] = h;
    stripeCompose(image, y, h, frameId);
  };
  if (typeof ImageDecoder !== 'undefined') {
    let d = null;
    try { d = new ImageDecoder({ data: data, type: 'image/jpeg' }); }
    catch (err) { return; }
    jpegPending++;
    d.decode().then((r) => { try { d.close(); } catch (err) {} done(r.image); })
      .catch(() => { try { d.close(); } catch (err) {} done(null); });
  } else if (typeof createImageBitmap === 'function') {
    jpegPending++;
    createImageBitmap(new Blob([data], { type: 'image/jpeg' })).then(done).catch(() => done(null));
  }
}

function onWire(buffer) {
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < 1) return;
  statsBytes += buffer.byteLength;
  if (stripedOn) {
    const type = new Uint8Array(buffer, 0, 1)[0];
    if (type === 0x03) onJpegStripe(buffer);
    else if (type === 0x04) onH264Stripe(buffer);
    return;
  }
  if (buffer.byteLength < 13) return;
  const head = new Uint8Array(buffer, 0, 12);
  if (wireExpect && wireCodecName(head[1]) !== wireExpect) return;
  const key = wireFrameIsKey(head[1]);
  const frameId = (head[2] << 8) | head[3];
  const w = (head[6] << 8) | head[7];
  const h = (head[8] << 8) | head[9];
  const reference = (head[10] << 8) | head[11];
  wireChunks++;
  if (frameId !== wireLastId) { wireFrames++; wireLastId = frameId; }
  const payload = buffer.slice(12);
  const bytes = new Uint8Array(payload);
  let codec = wireCodec;
  if (key) codec = codecStringFor(wireCodecName(head[1]), bytes, w, h, 0, false, wireChromium);
  else if (!codec) codec = wireHint;
  if (!codec) { sendNeedKey('no_codec'); return; }
  const framed = avcFramed(codec);
  const desc = key && framed ? avcDescription(bytes) : wireDesc;
  if (!dec || dec.state !== 'configured' || codec !== wireCodec || w !== wireW || h !== wireH
      || wireRange !== wireFullRange || (key && framed && !sameBytes(desc, wireDesc))) {
    // Only a keyframe may (re)configure: deltas against a lost state are noise.
    if (!key) { sendNeedKey('no_key'); return; }
    if (!configureDecoder(codec, w, h, wireSoftware, desc)) return;
    wireCodec = codec; wireW = w; wireH = h; wireDesc = desc; wireRange = wireFullRange;
    self.postMessage({ type: 'wireDims', w: w, h: h });
  }
  decodeChunk(key, framed ? annexbToAvcc(bytes) : payload, performance.now() * 1000, frameId, reference);
}

const stripedCaps = {
  stripedDecode: typeof VideoDecoder !== 'undefined',
  jpegDecode: typeof ImageDecoder !== 'undefined' || typeof createImageBitmap === 'function',
};
if (typeof VideoTrackGenerator !== 'undefined') {
  try {
    const g = new VideoTrackGenerator();
    writer = g.writable.getWriter();
    mode = 'vtg';
    self.postMessage(Object.assign({ type: 'mode', mode: 'vtg', track: g.track }, stripedCaps), [g.track]);
  } catch (e) { self.postMessage(Object.assign({ type: 'mode', mode: 'canvas' }, stripedCaps)); }
} else {
  self.postMessage(Object.assign({ type: 'mode', mode: 'canvas' }, stripedCaps));
}

self.onmessage = (e) => {
  const m = e.data;
  if (m.canvas) { oc = m.canvas; ctx = oc.getContext('2d', { desynchronized: true }); if (!mode) mode = 'canvas'; return; }
  if (m.type === 'decoderConfig') { configureDecoder(m.codec, m.codedWidth, m.codedHeight, m.software, m.description || null); return; }
  if (m.type === 'closeDecoder') { closeDecoder(); return; }
  if (m.type === 'statsOpen') { setStatsOpen(!!m.open); return; }
  if (m.type === 'chunk') {
    // Not ready yet; the page will resend a keyframe.
    decodeChunk(m.key, m.data, m.timestamp, m.frameId, m.reference);
    return;
  }
  if (m.type === 'wireIn') {
    if (m.codecHint) wireHint = m.codecHint;
    wireSoftware = !!m.software;
    wireChromium = !!m.chromium;
    wireAvcc = !!m.avcc;
    wireFullRange = !!m.fullRange;
    wirePort = m.port;
    m.port.onmessage = (ev) => onWire(ev.data);
    if (!wireStatsTimer) {
      wireStatsTimer = setInterval(() => {
        if (!wireChunks && !presentedFrames) return;
        const rows = {};
        if (stripedOn) {
          for (const y in stripeDecs) rows[y] = stripeDecs[y].h;
          for (const y in jpegRowHeights) if (!(y in rows)) rows[y] = jpegRowHeights[y];
        } else if (dec && wireH > 0) {
          rows[0] = wireH;
        }
        self.postMessage({ type: 'wireStats', chunks: wireChunks, frames: wireFrames, lastId: wireLastId, presents: presentedFrames, rows: rows });
        wireChunks = 0; wireFrames = 0; presentedFrames = 0;
      }, 1000);
    }
    return;
  }
  if (m.type === 'wireMode') {
    const striped = !!m.striped;
    wireExpect = m.codec || null;
    if (striped !== stripedOn) {
      stripedOn = striped;
      // The sink re-announces in the new mode, so the page re-hides its
      // canvas even when the old mode had already consumed 'presented'.
      presented = false;
      if (striped) closeDecoder(); else closeStripeState();
    }
    return;
  }
  if (m.type === 'wireGeom') {
    const know = m.w > 0 && m.h > 0;
    if (know && (m.w !== stripeGeomW || m.h !== stripeGeomH)) {
      stripeGeomW = m.w; stripeGeomH = m.h;
      if (stripeBack && (stripeBack.width !== m.w || stripeBack.height !== m.h)) {
        // A real geometry change; the server keyframes it, so stale rows go.
        stripeBack = null; stripeBackCtx = null;
        stripeDirty = false; stripePendingId = null;
        jpegLastRowId = {}; jpegRowHeights = {};
      }
    }
    stripeGeomKnown = stripeGeomKnown || know;
    return;
  }
  if (m.type === 'wireHints') {
    if (m.codecHint) wireHint = m.codecHint;
    if (m.software !== undefined) wireSoftware = !!m.software;
    if (m.fullRange !== undefined && !!m.fullRange !== wireFullRange) {
      wireFullRange = !!m.fullRange;
      if (dec || Object.keys(stripeDecs).length) sendNeedKey('color_range');
    }
    if (m.chromium !== undefined) wireChromium = !!m.chromium;
    if (m.avcc !== undefined) wireAvcc = !!m.avcc;
    return;
  }
  // Fallback: a main-thread-decoded frame transferred in.
  if (m.frame) {
    present(m.frame);
    ack();
  }
};`;function vi(){try{if(typeof MediaStreamTrackGenerator<`u`){let e=new MediaStreamTrackGenerator({kind:`video`});return{track:e,writable:e.writable}}}catch(e){console.warn(`MediaStreamTrackGenerator unavailable, using canvas:`,e)}return null}function yi(){if(b)return!0;if(!y)return!1;let e=vi();if(!e)return!1;x=e.track;try{b=e.writable.getWriter()}catch(e){console.warn(`track writer failed:`,e);try{x.stop()}catch{}return x=null,!1}if(b.closed&&b.closed.catch){let e=b;b.closed.catch(()=>{b===e&&Ii()})}try{y.srcObject=new MediaStream([x])}catch(e){console.warn(`srcObject failed:`,e);try{b.close()}catch{}b=null;try{x.stop()}catch{}return x=null,!1}let t=y.play();return t&&t.catch&&t.catch(()=>{}),!0}function bi(){if(b){try{b.close()}catch{}b=null}if(x){try{x.stop()}catch{}x=null}if(y)try{y.srcObject=null}catch{}}function xi(e){if(!yi())return!1;if(!S&&(S=!0,oe=null,de=!1,Yr&&Zr!==`vtg`&&$&&(Yr=!1,fe=!1,$.style.display=`none`),y)){if(y.style.display=`block`,y.style.objectFit=`fill`,typeof y.requestVideoFrameCallback==`function`){let e=++C;y.requestVideoFrameCallback(()=>{e===C&&S&&(de=!0,s&&(s.style.display=`none`))})}else de=!0}if(s&&y&&(de&&s.style.display!==`none`&&(s.style.display=`none`),(w||oe===null)&&(oe=s.style.cssText,y.style.cssText=oe,y.style.display=`block`,y.style.objectFit=`fill`,w=!1)),!de&&s&&c&&s.width>0&&s.height>0)try{c.drawImage(e,0,0)}catch{}if(b.desiredSize!==null&&b.desiredSize<=0)return e.close(),++ce>=30&&(console.warn(`Video track sink stalled (${ce} consecutive drops); rebuilding it.`),Ii()),!0;ce=0;let t=b;return b.write(e).catch(()=>{try{e.close()}catch{}b===t&&Ii()}),!0}function Si(){if(Q&&s&&s.width>0&&s.height>0)try{Q.postMessage({type:`wireGeom`,w:s.width,h:s.height})}catch{}}function Ci(){if(!Q||!l||typeof l.connectVideo!=`function`)return;let e=new MessageChannel;try{Q.postMessage({type:`wireIn`,port:e.port1,codecHint:oi,software:Vn,chromium:gn,avcc:le()===`avcc`,fullRange:Gn},[e.port1]);let t=Q;se.then(e=>{if(Q===t)try{t.postMessage({type:`wireHints`,avcc:e===`avcc`})}catch{}}),l.connectVideo(e.port2)}catch(e){console.warn(`Could not connect the socket worker to the video worker:`,e)}Si(),wi(!0)}function wi(e){let t=V===`h264enc-striped`||V===`jpeg`,n=qr&&Xr&&(V===`jpeg`?fi:di),r=!!(l&&typeof l.setVideoDivert==`function`&&Xr&&!si&&(t?n:ni&&H(V)));if(Q)try{Q.postMessage({type:`wireMode`,striped:t,codec:t?null:i(V)})}catch{}(r!==ci||t!==li||e)&&(ci=r,li=t,window.videoDivertOn=r,r||(window.videoStripeRows={}),l&&typeof l.setVideoDivert==`function`&&l.setVideoDivert(r,t?`present`:`receive`),r&&(t&&(_a(),yo()),Si(),Ai()))}let Ti=new Set;function Ei(){let e=Yr&&fi?` in the video worker`:` on the page`;return typeof ImageDecoder<`u`?`ImageDecoder${e}`:typeof createImageBitmap==`function`?`createImageBitmap${e}`:``}function Di(e){Ue=e,!Ti.has(e)&&(Ti.add(e),console.info(`[Selkies] video sink: ${e}`))}function Oi(){if(mi)return!1;if(Xr)return!0;if(Q)return!1;try{let e=URL.createObjectURL(new Blob([_i],{type:`text/javascript`}));return pi++,Q=new Worker(e),URL.revokeObjectURL(e),vr.open&&Q.postMessage({type:`statsOpen`,open:!0}),ti=0,Ci(),Q.onerror=e=>{console.warn(`video worker error:`,e&&e.message),ki()},Q.onmessage=e=>{let t=e.data;if(t){if(t.ack){ti>0&&ti--;return}if(t.type===`error`){ki();return}if(t.type===`presented`){fe=!0,Yr&&s&&(s.style.display=`none`);return}if(t.type===`needKeyframe`){console.info(`[VideoWorker] keyframe requested: ${t.reason}`),No();return}if(t.type===`lostFrame`){l&&l.readyState===WebSocket.OPEN&&l.send(`LOST_FRAME ${t.id}`);return}if(t.type===`decoderError`){si=!0,ri=null,ii=0,ai=0,oi=null,wi(),No();return}if(t.type===`decodeStats`){mr=t;return}if(t.type===`wireStats`){window.videoChunksReceived+=t.chunks,t.chunks>0&&(Ee=performance.now()),V===`h264enc-striped`||V===`jpeg`?Tr+=t.presents||0:ui+=t.frames,(t.presents||0)>0&&(k=performance.now()),t.lastId>=0&&(O=t.lastId,Ce=performance.now()),t.rows&&(window.videoStripeRows=t.rows),G&&t.chunks>0&&(gt=performance.now()),!xr&&(t.frames>0||(t.presents||0)>0)&&no(),ci&&(Ai(),gi());return}if(t.type===`wireDims`){G&&t.w>0&&t.h>0&&(R!==t.w||z!==t.h)&&(R=t.w,z=t.h,console.log(`Shared mode: stream is ${R}x${z} (physical).`),ua(R,z,!0));return}if(t.type===`mode`){if(di=!!t.stripedDecode,fi=!!t.jpegDecode,t.mode===`vtg`&&t.track){if(!y){ki();return}Zr=`vtg`,Qr=t.track;try{y.srcObject=new MediaStream([t.track]);let e=y.play();e&&e.catch&&e.catch(()=>{})}catch(e){console.warn(`VTG srcObject failed:`,e),ki();return}Di(`VideoTrackGenerator in the video worker.`),ni=!0,Xr=!0,pi=0,Si(),wi()}else if(Kr&&H(V)){Di(`MediaStreamTrackGenerator on the page — this browser exposes no VideoTrackGenerator to a worker.`),ki();return}else{if(Zr=`canvas`,Di(Kr?`OffscreenCanvas in the video worker for the striped codecs; full-frame H.264 presents through the page MediaStreamTrackGenerator.`:`OffscreenCanvas in the video worker — this browser exposes no VideoTrackGenerator to a worker and no MediaStreamTrackGenerator on the page, so frames are composited rather than handed to a <video> element.`),!$){ki();return}try{let e=$.transferControlToOffscreen();$r=!0,Q.postMessage({canvas:e},[e])}catch(e){console.warn(`OffscreenCanvas transfer failed:`,e),ki();return}ni=!Kr,Xr=!0,pi=0,Si(),wi()}}}},!1}catch(e){return console.warn(`video worker init failed, using main canvas:`,e),ki(),!1}}function ki(){let e=Zr===`vtg`;Di(Kr?`MediaStreamTrackGenerator on the page.`:`2D canvas on the page — no video worker sink.`);let t=$r;if(Yr=!1,Xr=!1,Zr=null,ni=!1,di=!1,fi=!1,hi=0,wi(),ti=0,$r=!1,fe=!1,C++,ri=null,ii=0,ai=0,oi=null,Q){try{Q.terminate()}catch{}Q=null}if(e){if(Qr){try{Qr.stop()}catch{}Qr=null}if(y){try{y.srcObject=null}catch{}y.style.display=`none`}}if(t&&$){let e=$.parentNode,t=document.createElement(`canvas`);t.id=$.id,t.style.display=`none`,e&&e.replaceChild(t,$),$=t}else $&&($.style.display=`none`);s&&(s.style.display=`block`)}function Ai(){let e=Zr===`vtg`?y:$;if(!e)return!1;if(!Yr&&(Yr=!0,ei=null,fe=!1,e!==y&&(S?Ii():y&&(y.style.display=`none`)),e.style.display=`block`,e.style.objectFit=`fill`,Zr===`vtg`)){if(typeof e.requestVideoFrameCallback==`function`){let t=++C;e.requestVideoFrameCallback(()=>{t===C&&Yr&&(fe=!0,s&&(s.style.display=`none`))})}else fe=!0}return s&&(fe&&s.style.display!==`none`&&(s.style.display=`none`),(w||ei===null)&&(ei=s.style.cssText,e.style.cssText=ei,e.style.display=`block`,e.style.objectFit=`fill`,w=!1)),!0}function ji(e){if(!Oi()||!Ai()||(gi(),mi))return!1;if(ti>=3){try{e.close()}catch{}return!0}try{Q.postMessage({frame:e},[e]),ti++}catch{try{e.close()}catch{}return ki(),!0}return!0}let Mi=-1/0,Ni=0;function Pi(e,t,n){let r=performance.now();if(r-Mi>=5e3){let i=Ni>0?` (+${Ni} suppressed)`:``;console.info(`[VideoWorker] decoder (re)configure: codec=${e} ${t}x${n}${ri?` (was ${ri} ${ii}x${ai})`:``}${i}`),Mi=r,Ni=0}else Ni++}function Fi(e,t,n,r,i,a,o){if(si||!Oi()||!Ai())return!1;let s=le()===`avcc`&&i.startsWith(`avc1`);if(i!==ri||n!==ii||r!==ai){if(s&&!e)return No(),!0;Pi(i,n,r);let a=s?ne(new Uint8Array(t)):null;try{Q.postMessage({type:`decoderConfig`,codec:i,codedWidth:n,codedHeight:r,software:Vn,description:a})}catch{return!1}ri=i,ii=n,ai=r,No()}let c=s?re(new Uint8Array(t)).buffer:t;try{Q.postMessage({type:`chunk`,key:e,data:c,timestamp:performance.now()*1e3,frameId:a,reference:o},[c])}catch{return!1}return!0}function Ii(){S&&(S=!1,ce=0,de=!1,C++,y&&(y.style.display=`none`),s&&(s.style.display=``),bi())}let Li=(e,t,i,a)=>{let o=t&&r(e)&&t.byteLength?new Uint8Array(t):null;return ee(n(e),o,i,a,$n,tr,gn)},Ri=()=>{if(!s)return;if(w=!0,!Jt){s.style.imageRendering!==`pixelated`&&(console.log(`Anti-aliasing disabled by setting. Forcing 'pixelated' rendering.`),s.style.imageRendering=`pixelated`,s.style.setProperty(`image-rendering`,`crisp-edges`,``));return}let e=window.devicePixelRatio||1;G||window.manual_resolution||Math.abs(Nt()-e)>1e-6?s.style.imageRendering!==`auto`&&(console.log(`Smoothing enabled for manual resolution, high-DPR scaling, or shared mode.`),s.style.imageRendering=`auto`):s.style.imageRendering!==`pixelated`&&(console.log(`Setting canvas rendering to 'pixelated' for 1:1 display.`),s.style.imageRendering=`pixelated`,s.style.setProperty(`image-rendering`,`crisp-edges`,``))},zi=()=>{let e=document.createElement(`style`);e.textContent=`
body {
  font-family: sans-serif;
  margin: 0;
  padding: 0;
  overflow: hidden;
  background-color: #000;
  color: #fff;
}
#app {
  display: flex;
  flex-direction: column;
  height: calc(var(--vh, 1vh) * 100);
  width: 100%;
}
.video-container {
  flex-grow: 1;
  flex-shrink: 1;
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: center;
  height: 100%;
  width: 100%;
  position: relative;
  overflow: hidden;
}
.video-container video,
.video-container canvas,
.video-container #overlayInput {
    position: absolute;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
}
.video-container video {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
  display: none;
}
.video-container #videoCanvas {
    z-index: 2;
    pointer-events: none;
    display: block;
}
.video-container #overlayInput {
    opacity: 0;
    z-index: 3;
    caret-color: transparent;
    background-color: transparent;
    color: transparent;
    pointer-events: auto;
    -webkit-user-select: none;
    border: none;
    outline: none;
    padding: 0;
    margin: 0;
}
.video-container #playButton {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  z-index: 10;
}
.hidden {
  display: none !important;
}
.video-container .status-bar {
  position: absolute;
  bottom: 0;
  left: 0;
  width: 100%;
  padding: 5px;
  background-color: rgba(0, 0, 0, 0.7);
  color: #fff;
  text-align: center;
  z-index: 5;
}
#playButton {
  padding: 15px 30px;
  font-size: 1.5em;
  cursor: pointer;
  background-color: rgba(0, 0, 0, 0.5);
  color: white;
  border: 1px solid rgba(255, 255, 255, 0.3);
  border-radius: 3px;
  backdrop-filter: blur(5px);
}
.video-container.shared-user-mode #overlayInput {
  cursor: default !important;
}
  `,document.head.appendChild(e)};async function Bi(){for(let e of[`h264`,`h265`,`vp9`])pe(e);let e=i(V);a(e)&&(await pe(e)||X(`video_fullcolor`,!1)&&(console.warn(`[Selkies] full color (4:4:4) is off: this browser decodes ${e} 4:2:0 only.`),tr=!1,Pr(`video_fullcolor`,!1)))}let Vi=!1;async function Hi(e){if(!tr||Vi||G)return!1;let t=i(V);return!a(t)||Xi(t)===!1||await pe(t)||!tr?!1:(console.warn(`[Selkies] full color (4:4:4) is off: this browser decodes ${t} 4:2:0 only.`),tr=!1,Pr(`video_fullcolor`,!1),aa(e),!0)}let Ui=e=>/^(avc1\.F4|hev1\.4\.|vp09\.01)/i.test(e),Wi=null,Gi=!1,Ki=null,qi=!1,Ji=null,Yi=null;function Xi(e){let t=Yi&&Yi[e];if(!t||!t.fullcolor)return null;let n=t.fullcolor[ar||!t.hardware?`software`:`hardware`];return typeof n==`boolean`?n:null}let Zi=new Set,Qi=[`h264enc`,`av1enc`,`vp8enc`,`h265enc`,`vp9enc`,`h264enc-striped`,`jpeg`],$i=[`av1enc`,`h265enc`,`vp9enc`,`h264enc`,`vp8enc`];function ea(e){e&&Zi.add(e);let t=Array.isArray(Ji)&&Ji.length?Ji:Qi,n=Qi.filter(e=>t.includes(e)),r=e=>H(e)&&!!(Yi&&(Yi[i(e)]||{}).hardware),o=$i.filter(e=>n.includes(e)&&r(e));for(let e of[...o,...n.filter(e=>!r(e))]){if(e===V)continue;if(e===`jpeg`)return e;let t=i(e);if(!Zi.has(t)&&ue(e)&&!(Vi&&tr&&a(t)&&Xi(t)!==!1&&me(t)===!1))return e}return null}let ta=e=>ea(i(e))||`jpeg`;function na(e,t){if(!(Gi||Wi)){if(Ui(e)&&!Vi&&!G){if(!tr)return;Hi(`no decoder for ${e}`).then(n=>{n||ra(e,t)});return}ra(e,t)}}function ra(e,t){if(Gi||Wi)return;let n=!G&&!qi&&V!==`jpeg`?ea(t):null;if(n){Wi=n,console.warn(`This browser has no decoder for ${e}; switching to the ${n} encoder.`),V=n,Ir(`encoder`,n),si=!1,ri=null,ii=0,ai=0,oi=null,wi(),aa(`no decoder for ${e}`);return}Gi=!0,Ki={encoder:V,fullcolor:tr},console.error(`This session streams ${e}, which this browser cannot decode.`),q&&(q.textContent=`Error: This session streams ${ae(t)} video, which this browser cannot decode.`,q.classList.remove(`hidden`))}function ia(e,t){if(qi=!!(t&&(t.locked||Array.isArray(t.allowed)&&t.allowed.length===1)),Ji=t&&Array.isArray(t.allowed)?t.allowed.slice():null,Wi&&=(e!==Wi&&(qi=!0),null),!ue(e)){na(e,i(e));return}Gi&&(e!==Ki.encoder||tr!==Ki.fullcolor)&&(Gi=!1,q&&q.classList.add(`hidden`))}function aa(e){if(!G){if(l&&l.readyState===WebSocket.OPEN){let t=sa(),n=`SETTINGS,${JSON.stringify(t)}`;l.send(n),console.log(`[websockets] Sent full settings update. Reason: ${e}`)}else console.warn(`[websockets] Cannot send full settings update. Reason: ${e}. WebSocket not open.`)}}function oa(e){let n=document.getElementById(`videoCanvas`),r=null;for(let e of[`videoCanvas`,`videoStream`,`videoWorkerCanvas`]){let t=document.getElementById(e),n=t&&t.getBoundingClientRect?t.getBoundingClientRect():null;if(n&&n.width>0){r=[n.width,n.height];break}}let i=(t||{})[N];return qe({stream:n&&n.width>0?[n.width,n.height]:null,css:r,realized:i?[i.w,i.h]:null,density:e})}function sa(){let e={},t=Nt();Ft=t;let n=e=>{let t=`${Rn}_${e}`;return N===`display2`&&P.includes(e)&&(t=`${t}_${N}`),window.localStorage.getItem(t)!==null},r=[[`framerate`,()=>Y(`framerate`,60)],[`video_crf`,()=>Y(`video_crf`,25)],[`encoder`,()=>Fr(`encoder`,`h264enc`)],[`manual_resolution`,()=>X(`manual_resolution`,!1)],[`audio_bitrate`,()=>Y(`audio_bitrate`,32e4)],[`video_fullcolor`,()=>X(`video_fullcolor`,!1)],[`video_streaming_mode`,()=>X(`video_streaming_mode`,!1)],[`jpeg_quality`,()=>Y(`jpeg_quality`,60)],[`paint_over_jpeg_quality`,()=>Y(`paint_over_jpeg_quality`,90)],[`use_cpu`,()=>X(`use_cpu`,!1)],[`video_paintover_crf`,()=>Y(`video_paintover_crf`,18)],[`video_paintover_burst_frames`,()=>Y(`video_paintover_burst_frames`,5)],[`use_paint_over_quality`,()=>X(`use_paint_over_quality`,!0)],[`scaling_dpi`,()=>Y(`scaling_dpi`,96)],[`enable_binary_clipboard`,()=>X(`enable_binary_clipboard`,!1)],[`rate_control_mode`,()=>Fr(`rate_control_mode`,`crf`)],[`video_bitrate`,()=>Y(`video_bitrate`,8e3)],[`force_aligned_resolution`,()=>X(`force_aligned_resolution`,!1)]];for(let[t,i]of r)n(t)&&(e[t]=i());if(e.scaling_dpi=Ut(),Cn&&(e.keyboardLayout=Cn),window.manual_resolution&&R!=null&&z!=null)e.manual_resolution=!0,e.manual_width=Z(R),e.manual_height=Z(z);else{let n=document.querySelector(`.video-container`),r=n?n.getBoundingClientRect():{width:window.innerWidth,height:window.innerHeight};e.manual_resolution=!1;let i=Z(r.width*t),a=Z(r.height*t);i>4080&&(i=4080),a>4080&&(a=4080),e.initialClientWidth=i,e.initialClientHeight=a}return e.useCssScaling=kt,e.displayId=N,e.displayScale=oa(t),N===`display2`&&(e.displayPosition=Le),e.audioRedundancy=!0,e}function ca(e,t){if(G){console.log(`Shared mode: Resolution sending to server is blocked.`);return}let n,r,i=1;window.manual_resolution?(n=Z(e),r=Z(t)):(i=Nt(),Pt=i,window.webrtcInput&&window.webrtcInput.setStreamDensity&&window.webrtcInput.setStreamDensity(i),n=Z(e*i),r=Z(t*i),Ft>0&&Math.abs(i-Ft)>1e-6&&setTimeout(()=>aa(`stream density`),0));let a=n>4080||r>4080;n>4080&&(n=4080),r>4080&&(r=4080),It=window.manual_resolution||a?null:[n,r,e,t];let o=`${n}x${r}`;console.log(`Sending resolution to server: ${o}, DisplayID: ${N}, Manual Mode: ${window.manual_resolution}, Pixel Ratio Used: ${i}, useCssScaling: ${kt}`),l&&l.readyState===WebSocket.OPEN?l.send(`r,${o},${N}`):console.warn(`Cannot send resolution via WebSocket: Connection not open.`)}function la(){if(!s)return;let e=null,t=!1,n=!1;if(S&&y?(e=y,t=de,n=!0):Yr&&(e=Zr===`vtg`?y:$,t=fe),!e)return;let r=s.style.cssText;e.style.cssText=r,e.style.display=`block`,e.style.objectFit=`fill`,n?oe=r:ei=r,w=!1,t&&(s.style.display=`none`)}function ua(e,t,n){if(!s||!s.parentElement){console.error(`Cannot apply manual canvas style: Canvas or parent container not found.`);return}if(e<=0||t<=0){console.warn(`Cannot apply manual canvas style: Invalid target dimensions ${e}x${t}`);return}w=!0,za={};let r=G||window.manual_resolution?1:Nt(),i=Z(e*r),a=Z(t*r);(s.width!==i||s.height!==a)&&(s.width=i,s.height=a,console.log(`Canvas internal buffer set to: ${i}x${a}`),Si());let o=s.parentElement,c=o.clientWidth,l=o.clientHeight,u,d,f,p;if(n){let n=e/t,r=c/l,o,m;n>r?(o=c,m=c/n):(m=l,o=l*n);let h=(l-m)/2,ee=(c-o)/2;u=`${o}px`,d=`${m}px`,f=`${h}px`,p=`${ee}px`,s.style.position=`absolute`,s.style.width=u,s.style.height=d,s.style.top=f,s.style.left=p,s.style.objectFit=`contain`,console.log(`Applied manual style (Scaled): CSS ${o.toFixed(2)}x${m.toFixed(2)}, Buffer ${i}x${a}, Pos ${ee.toFixed(2)},${h.toFixed(2)}`)}else{let n=window.devicePixelRatio||1,r=e/n,o=t/n;u=`${r}px`,d=`${o}px`;let m=(l-o)/2,h=(c-r)/2;f=`${m}px`,p=`${h}px`,s.style.position=`absolute`,s.style.width=u,s.style.height=d,s.style.top=f,s.style.left=p,s.style.objectFit=`fill`,console.log(`Applied manual style (Exact): CSS ${r.toFixed(2)}x${o.toFixed(2)}, Buffer ${i}x${a}, Pos ${h.toFixed(2)},${m.toFixed(2)}`)}s.style.display=`block`,Ri(),la();let m=document.getElementById(`overlayInput`);m&&(m.style.position=`absolute`,m.style.width=u,m.style.height=d,m.style.top=f,m.style.left=p),window.webrtcInput&&typeof window.webrtcInput.resize==`function`&&window.webrtcInput.resize()}function da(e,t){if(!s)return;if(e<=0||t<=0){console.warn(`Cannot reset canvas style: Invalid stream dimensions ${e}x${t}`);return}za={},w=!0;let n=Nt(),r=Z(e*n),i=Z(t*n);(s.width!==r||s.height!==i)&&(s.width=r,s.height=i,console.log(`Canvas internal buffer reset to: ${r}x${i}`),Si());let a=`${e}px`,o=`${t}px`;s.style.width=a,s.style.height=o;let c=document.getElementById(`overlayInput`);c&&(c.style.width=a,c.style.height=o,c.style.position=`absolute`);let l=s.parentElement;if(l){let n=l.clientWidth,a=l.clientHeight,o=Math.floor((n-e)/2),u=Math.floor((a-t)/2);s.style.position=`absolute`,s.style.top=`${u}px`,s.style.left=`${o}px`,c&&(c.style.top=`${u}px`,c.style.left=`${o}px`),console.log(`Reset canvas CSS to ${e}px x ${t}px, Pos ${o},${u}, object-fit: fill. Buffer: ${r}x${i}`)}else s.style.position=`absolute`,s.style.top=`0px`,s.style.left=`0px`,c&&(c.style.top=`0px`,c.style.left=`0px`),console.log(`Reset canvas CSS to ${e}px x ${t}px, Pos 0,0 (no parent metrics), object-fit: fill. Buffer: ${r}x${i}`);s.style.objectFit=`fill`,s.style.display=`block`,Ri(),la(),window.webrtcInput&&typeof window.webrtcInput.resize==`function`&&window.webrtcInput.resize()}function fa(){pa&&(console.log(`Switching to Auto Mode: Removing direct manual local scaling listener.`),window.removeEventListener(`resize`,pa)),wt?(console.log(`Switching to Auto Mode: Adding original (auto) debounced resize listener.`),window.removeEventListener(`resize`,wt),window.addEventListener(`resize`,wt),typeof B==`function`?(console.log(`Triggering immediate auto-resize calculation for auto mode.`),B()):console.warn(`handleResizeUI function not directly callable from enableAutoResize. Auto-resize will occur on next event.`)):console.warn(`Cannot enable auto-resize: originalWindowResizeHandler not found.`)}let pa=()=>{window.manual_resolution&&!G&&R!=null&&z!=null&&R>0&&z>0&&ua(R,z,wr)};function ma(){wt&&(console.log(`Switching to Manual Mode Local Scaling: Removing original (auto) resize listener.`),window.removeEventListener(`resize`,wt)),console.log(`Switching to Manual Mode Local Scaling: Adding direct manual scaling listener.`),window.removeEventListener(`resize`,pa),window.addEventListener(`resize`,pa),window.manual_resolution&&!G&&R!=null&&z!=null&&R>0&&z>0&&(console.log(`Applying current manual canvas style after enabling direct manual resize handler.`),ua(R,z,wr))}function ha(){if(!G)return;let e=document.querySelector(`.video-container`);e&&(e.classList.add(`shared-user-mode`),console.log(`Shared mode: Added 'shared-user-mode' class to video container.`));let t=document.getElementById(`globalFileInput`);t&&(t.disabled=!0,console.log(`Shared mode: Disabled globalFileInput.`))}let ga=()=>{zi(),ln(),window.addEventListener(`resize`,ln),window.addEventListener(`requestFileUpload`,Ja);let e=document.getElementById(`app`);if(!e){console.error(`FATAL: Could not find #app element.`);return}let t=document.createElement(`div`);t.className=`video-container`,q=document.createElement(`div`),q.id=`status-display`,q.className=`status-bar`,q.textContent=`Connecting...`,t.appendChild(q),J=document.createElement(`input`),J.type=`search`,J.readOnly=!1,J.autocomplete=`off`,J.inputMode=`none`,J.virtualKeyboardPolicy=`manual`,J.setAttribute(`autocorrect`,`off`),J.setAttribute(`autocapitalize`,`off`),J.setAttribute(`spellcheck`,`false`),J.id=`overlayInput`,t.appendChild(J),s=document.getElementById(`videoCanvas`),s||(s=document.createElement(`canvas`),s.id=`videoCanvas`),t.appendChild(s);let n=Mn.get(`offscreen_worker`),r=n===null?X(`offscreen_worker`,!0):n.toLowerCase()===`true`;qr=r,Jr=r,!qr&&Kr?Di(`MediaStreamTrackGenerator on the page.`):qr||Di(`2D canvas on the page — `+(r?`no MediaStreamTrackGenerator in this browser and no video worker.`:`the video worker is disabled (offscreen_worker=false).`)+` Every frame is drawn by hand, which costs more CPU than a <video> sink.`),(Kr||qr)&&(y=document.getElementById(`videoStream`),y||(y=document.createElement(`video`),y.id=`videoStream`,y.autoplay=!0,y.muted=!0,y.playsInline=!0,y.disableRemotePlayback=!0),y.style.display=`none`,t.appendChild(y)),qr&&($=document.getElementById(`videoWorkerCanvas`),$||($=document.createElement(`canvas`),$.id=`videoWorkerCanvas`),$.style.display=`none`,t.appendChild($)),qr&&Oi(),G?((!R||R<=0||!z||z<=0)&&(R=1280,z=720),ua(R,z,!0),window.addEventListener(`resize`,()=>{G&&R&&z&&R>0&&z>0&&ua(R,z,!0)}),console.log(`Initialized UI in Shared Mode: Canvas buffer target ${R}x${z} (logical), will scale to fit viewport.`)):manual_resolution&&R!=null&&z!=null&&R>0&&z>0?(ua(R,z,wr),ma(),console.log(`Initialized UI in Manual Resolution Mode: ${R}x${z} (logical), ScaleLocally: ${wr}`)):(da(1024,768),console.log(`Initialized UI in Auto Resolution Mode (defaulting to 1024x768 logical for now)`)),c=s.getContext(`2d`,{desynchronized:!0}),c||console.error(`Failed to get 2D rendering context`),kr=document.createElement(`button`),kr.id=`playButton`,kr.textContent=`Play Stream`,t.appendChild(kr),kr.classList.add(`hidden`),q.classList.remove(`hidden`);let i=document.createElement(`div`);i.id=`dev-sidebar`;let a=document.createElement(`input`);if(a.type=`file`,a.id=`globalFileInput`,a.multiple=!0,a.style.display=`none`,document.body.appendChild(a),a.addEventListener(`change`,Ya),!document.getElementById(`keyboard-input-assist`)){let e=document.createElement(`input`);e.type=`search`,e.id=`keyboard-input-assist`,e.style.position=`absolute`,e.style.left=`-9999px`,e.style.top=`-9999px`,e.style.width=`1px`,e.style.height=`1px`,e.style.opacity=`0`,e.style.border=`0`,e.style.padding=`0`,e.style.caretColor=`transparent`,e.setAttribute(`aria-hidden`,`true`),e.setAttribute(`autocomplete`,`off`),e.setAttribute(`autocorrect`,`off`),e.setAttribute(`autocapitalize`,`off`),e.setAttribute(`spellcheck`,`false`),document.body.appendChild(e),console.log(`Dynamically added #keyboard-input-assist element.`)}e.appendChild(t),Gr(),kr.addEventListener(`click`,Wr),G&&ha()};function _a(){console.log(`Clearing all VNC stripe decoders.`);for(let e in Tt)if(Tt.hasOwnProperty(e)){let t=Tt[e];if(t.decoder&&t.decoder.state!==`closed`)try{t.decoder.close(),console.log(`Closed VNC stripe decoder for Y=${e}`)}catch(t){console.error(`Error closing VNC stripe decoder for Y=${e}:`,t)}}Tt={},Et={},console.log(`All VNC stripe decoders and metadata cleared.`)}function va(e,t){if(ni&&!si&&H(V)){let n=performance.now(),r=Et[t],i=r&&n-r.last<=1e4?r.count+1:1;if(Et[t]={count:i,last:n},i<=12){console.warn(`stripe decoder error on Y=${t} (worker path healthy; soft ${i}/12):`,e&&e.name);let n=Tt[t];if(n){try{n.decoder.close()}catch{}delete Tt[t]}No();return}}Fo(e,`stripe_decoder_Y=${t}`)}function ya(){for(let e in Tt){let t=Tt[e];if(t&&t.decoder&&(t.decoder.decodeQueueSize>0||t.pendingChunks&&t.pendingChunks.length>0))return!1}return!0}function ba(e){let t=Tt[e];if(t&&t.decoder.state===`configured`&&t.pendingChunks)for(console.log(`Processing ${t.pendingChunks.length} pending chunks for stripe Y=${e}`);t.pendingChunks.length>0;){let n=t.pendingChunks.shift(),r=new EncodedVideoChunk({type:n.type,timestamp:n.timestamp,data:n.data});try{t.decoder.decode(r)}catch(t){console.error(`Error decoding pending chunk for stripe Y=${e}:`,t,r)}}}let xa=[],Sa=null,Ca=null,wa=null,Ta=!1,Ea=null,Da=0,Oa=Sn();function ka(){return s?(Sa||(Sa=document.createElement(`canvas`),Ca=Sa.getContext(`2d`,{desynchronized:!0})),(Sa.width!==s.width||Sa.height!==s.height)&&(Sa.width=s.width,Sa.height=s.height,wa=null,Ta=!1),Ca):null}let Aa=null,ja=!1,Ma=0,Na=0;function Pa(){if(Aa){try{Aa.terminate()}catch{}Aa=null}ja=!1,Ma=0,Na=0}function Fa(){if(Aa)return!0;if(!Jr||typeof Worker>`u`||typeof OffscreenCanvas>`u`||typeof createImageBitmap!=`function`)return!1;try{let e=URL.createObjectURL(new Blob([`
let back = null, bctx = null;
function ensureBack(w, h) {
  if (!back || back.width !== w || back.height !== h) {
    back = new OffscreenCanvas(w, h);
    bctx = back.getContext('2d', { desynchronized: true, alpha: false });
  }
}
self.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'resize') { ensureBack(m.width, m.height); return; }
  if (m.type === 'stripe') {
    if (bctx) { try { bctx.drawImage(m.frame, 0, m.yPos); } catch (err) {} }
    try { m.frame.close(); } catch (err) {}
    return;
  }
  if (m.type === 'commit') {
    if (!back) return;
    createImageBitmap(back).then((bitmap) => { self.postMessage({ type: 'frame', bitmap: bitmap }, [bitmap]); }).catch(() => {});
    return;
  }
};
`],{type:`text/javascript`}));Aa=new Worker(e),URL.revokeObjectURL(e)}catch{return Aa=null,!1}return console.info(`[Selkies] striped codecs: compositing on an OffscreenCanvas in a worker.`),Aa.onerror=()=>Pa(),Aa.onmessage=e=>{let t=e.data;if(t&&t.type===`frame`){if(c&&s&&s.width>0&&s.height>0)try{c.drawImage(t.bitmap,0,0)}catch{}try{t.bitmap.close()}catch{}}},Ma=0,Na=0,!0}function Ia(){return Fa()?(ja=!0,s.width>0&&s.height>0&&(Ma!==s.width||Na!==s.height)&&(Aa.postMessage({type:`resize`,width:s.width,height:s.height}),Ma=s.width,Na=s.height,wa=null,Ta=!1)):(ja=!1,ka()),!!(s&&s.width>0&&s.height>0)}function La(e,t){if(ja&&Aa)try{Aa.postMessage({type:`stripe`,frame:e,yPos:t},[e]);return}catch{}else if(Ca)try{Ca.drawImage(e,0,t)}catch{}try{e.close()}catch{}}function Ra(){if(Tr++,k=performance.now(),Ea=wa,Da=performance.now(),ja&&Aa)try{Aa.postMessage({type:`commit`})}catch{}else c&&s.width>0&&s.height>0&&c.drawImage(Sa,0,0)}let za={};function Ba(){rt!==null&&(clearTimeout(rt),rt=null),ot=0}function Va(){if(G)return;let e=window.videoChunksReceived;No(),setTimeout(()=>{if(!(document.hidden||window.videoChunksReceived!==e)&&T&&l&&l.readyState===WebSocket.OPEN){console.warn(`No video since the tab came back; restarting the stream.`);try{l.send(`START_VIDEO`)}catch{return}Ua()}},2500)}function Ha(){if(rt=null,document.hidden){ot=0;return}if(!l||l.readyState!==WebSocket.OPEN){ot=0;return}if(ot++,ot<=3){console.warn(`No video after START_VIDEO; resend attempt ${ot}/3.`);try{l.send(`START_VIDEO`)}catch{}rt=setTimeout(Ha,lt)}else{console.warn(`START_VIDEO watchdog exhausted; forcing websocket reconnect.`),ot=0;try{l.close()}catch{}}}function Ua(){rt!==null&&clearTimeout(rt),ot=0,rt=setTimeout(Ha,lt)}function Wa(){pt!==null&&(clearInterval(pt),pt=null),_t=0,yt=0}function Ga(){G&&pt===null&&(gt=performance.now(),_t=0,yt=0,pt=setInterval(()=>{if(document.hidden||In||Fn!==`ready`){gt=performance.now();return}if(!l||l.readyState!==WebSocket.OPEN)return;let e=performance.now(),t=e-gt;if(t<bt||e<yt)return;_t++;let n=Math.min(bt*2**(_t-1),3e4);yt=e+n,console.warn(`Shared mode: no video chunk for ${Math.round(t)}ms; resending START_VIDEO (attempt ${_t}, next retry in ${n}ms).`);try{l.send(`START_VIDEO`)}catch{}},1e3))}function Ka(e,t){if(vr.open&&hr(t),H(V)&&e===0){if(document.hidden||u===`websockets`&&!G&&!T){try{t.close()}catch{}return}if(xa.length>0){for(let e of xa)try{e.frame.close()}catch{}xa.length=0}if(!(Kr&&xi(t))&&!(qr&&ji(t))){s&&c&&s.width>0&&s.height>0&&c.drawImage(t,0,0);try{t.close()}catch{}}k=performance.now(),xr||no();return}xa.push({yPos:e,frame:t,frameId:t.timestamp})}let qa=vt({canUpload:()=>!G}),Ja=qa.handleRequestFileUpload,Ya=qa.handleFileInputChange,Xa=qa.handleDragOver,Za=qa.handleDrop,Qa=async()=>{if(Dt===null){if(`wakeLock`in navigator)try{Dt=await navigator.wakeLock.request(`screen`),Dt.addEventListener(`release`,()=>{console.log(`Screen Wake Lock was released automatically.`),Dt=null}),console.log(`Screen Wake Lock is active.`)}catch(e){console.warn(`Could not acquire Wake Lock: ${e.name}, ${e.message}`)}else console.warn(`Wake Lock API is not supported by this browser.`)}},$a=async()=>{Dt!==null&&(await Dt.release(),Dt=null)};function eo(e,t){let n;return function(...r){clearTimeout(n),n=setTimeout(()=>{e.apply(this,r)},t)}}function to(){q&&q.classList.add(`hidden`),kr&&kr.classList.add(`hidden`)}let no=()=>{xr||(xr=!0,to(),console.log(`Stream started (UI elements hidden).`))},ro=()=>{if(Cr){console.log(`Input already initialized. Skipping.`);return}f!==null&&f>0&&(jn=f-1,console.log(`Input Initialization: Applying server-provided slot ${f}. Gamepad will target index ${jn}.`)),Cr=!0,console.log(`Initializing Input system...`);let e,n=e=>{l&&l.readyState===WebSocket.OPEN?l.send(e):console.warn(`initializeInput: WebSocket not open, cannot send input message:`,e)};if(!J){console.error(`initializeInput: overlayInput element not found. Cannot initialize input handling.`),Cr=!1;return}if(e=new Re(J,n,G,jn,kt,f),e.setShortcutsEnabled(rn),e.onmenuhotkey=()=>{window.postMessage({type:`toggleDashboard`},window.location.origin)},e.ongamepadhotkey=()=>{window.postMessage({type:`toggleTouchGamepad`},window.location.origin)},e.gamingMode=Hr,e.ongamingmode=e=>{Hr=e,window.postMessage({type:`gamingModeUpdate`,active:e},window.location.origin)},e.onnotice=(e,t)=>{window.postMessage({type:`fileUpload`,payload:{status:`warning`,fileName:e,message:t,code:e}},window.location.origin)},e.getWindowResolution=()=>{let e=document.querySelector(`.video-container`);if(!e)return console.warn(`initializeInput: .video-container not found, using window inner dimensions for resolution calculation.`),[window.innerWidth,window.innerHeight];let t=e.getBoundingClientRect();return[t.width,t.height]},e.ongamepadconnected=t=>{console.log(`Client: Gamepad "${t}" connected. isSharedMode: ${G}, isGamepadEnabled (global toggle): ${Se}`);let n=e.gamepadManager;n?G?(n.enable(),console.log(`Shared mode: Gamepad connected, ensuring its GamepadManager is active for polling.`)):Se?(n.enable(),console.log(`Primary mode: Gamepad connected, master gamepad toggle is ON. Ensuring its GamepadManager is active.`)):(n.disable(),console.log(`Primary mode: Gamepad connected, but master gamepad toggle is OFF. Disabling its GamepadManager.`)):console.warn(`Client: gamepadManager not found in ongamepadconnected. Cannot control its polling state.`)},e.ongamepaddisconnected=()=>{console.log(`Gamepad disconnected.`)},e.attach(),d===`viewer`){let t=f===null?`(no slot)`:`(gamepad-only slot ${f})`;console.log(`Role is 'viewer' ${t}. Detaching context to disable mouse/keyboard/touch.`),e.detach_context()}if(window.webrtcInput=e,e.setDisplayLayouts(t,N),Qt(),en(),nn(),J){let e=e=>{Qa()};J.removeEventListener(`pointerdown`,e),J.addEventListener(`pointerdown`,e),J.addEventListener(`contextmenu`,e=>{e.preventDefault()})}let r=()=>{if(!ke)return;if(G){console.log(`Shared mode: handleResizeUI (auto-resize logic) skipped.`),R&&z&&R>0&&z>0&&ua(R,z,!0);return}if(window.manual_resolution){console.log(`handleResizeUI: Auto-resize skipped, manual resolution mode is active.`);return}if(window.enable_resize===!1&&N!==`display2`){console.log(`handleResizeUI: Auto-resize skipped, dynamic resizing is disabled.`);return}console.log(`handleResizeUI: Auto-resize triggered (e.g., by window resize event).`);let t=e.getWindowResolution(),n=Z(t[0]),r=Z(t[1]),i=Nt();Pt=i,e&&e.setStreamDensity&&e.setStreamDensity(i);let a=4080;if(n*i>a&&(n=Math.floor(a/i),n=Z(n)),r*i>a&&(r=Math.floor(a/i),r=Z(r)),n<=0||r<=0){console.warn(`handleResizeUI: Calculated invalid dimensions (${n}x${r}). Skipping resize send.`);return}_a(),window.streamResolutionDiverged=!1,ca(n,r),da(n,r)};if(B=r,wt=eo(()=>{Kt(),r()},500),(()=>{let e=null,t=()=>{Kt(),typeof B==`function`&&B(),n()},n=()=>{if(e)try{e.removeEventListener(`change`,t)}catch{}let n=window.devicePixelRatio||1;e=window.matchMedia(`(resolution: ${n}dppx)`),e.addEventListener(`change`,t,{once:!0})};n(),setInterval(Kt,1e3)})(),G)console.log(`Shared mode: Auto-resize event listener (originalWindowResizeHandler) NOT attached.`);else if(window.manual_resolution)console.log(`initializeInput: Manual resolution mode active. Initial resolution already sent by onopen.`),R!=null&&z!=null&&R>0&&z>0?ma():console.warn(`initializeInput: Manual mode is set, but manual_width/Height are invalid. Canvas might not display correctly.`);else{console.log(`initializeInput: Auto-resolution mode. Attaching 'resize' event listener for subsequent changes.`),window.addEventListener(`resize`,wt);let e=document.querySelector(`.video-container`),t,n;if(e){let r=e.getBoundingClientRect();t=Z(r.width),n=Z(r.height)}else t=Z(window.innerWidth),n=Z(window.innerHeight);(t<=0||n<=0)&&(console.warn(`initializeInput: Current auto-calculated dimensions are invalid (${t}x${n}). Defaulting canvas style to 1024x768 (logical) for initial setup. The resolution sent by onopen should prevail on the server.`),t=1024,n=768),da(t,n),console.log(`initializeInput: Canvas style reset to reflect current auto-dimensions: ${t}x${n} (logical). Initial resolution was already sent by onopen.`)}J&&!G?(J.addEventListener(`dragover`,Xa),J.addEventListener(`drop`,Za)):J&&G?console.log(`Shared mode: Drag/drop file upload listeners NOT attached to overlayInput.`):console.warn(`initializeInput: overlayInput not found, cannot attach drag/drop listeners.`),console.log(`Input system initialized.`)};async function io(){if(!We){console.log(`No preferred output device set, using default.`);return}if(!(typeof AudioContext<`u`&&`setSinkId`in AudioContext.prototype)){console.warn(`Browser does not support setSinkId, cannot apply output device preference.`);return}if(m){if(m.state===`running`)try{await m.setSinkId(We),console.log(`Playback AudioContext output set to device: ${We}`)}catch(e){console.error(`Error setting sinkId on Playback AudioContext (ID: ${We}): ${e.name}`,e)}else console.warn(`Playback AudioContext not running (state: ${m.state}), cannot set sinkId yet.`)}else console.log(`Playback AudioContext doesn't exist yet, sinkId will be applied on initialization.`)}window.addEventListener(`message`,co,!1);function ao(){let e=window.webrtcInput&&window.webrtcInput.gamepadManager;if(!e){console.warn(`Client: window.webrtcInput.gamepadManager not found; cannot apply the gamepad toggle.`);return}G||Se?(e.enable(),console.log(G?`Shared mode: GamepadManager polling stays active.`:`Gamepad toggle ON. Enabling GamepadManager polling.`)):(e.disable(),console.log(`Gamepad toggle OFF. Disabling GamepadManager polling.`))}function oo(e){if(G||N!==`primary`)return;let t=t=>e&&e[t]||null,n=(e,n)=>{let r=t(e);return r&&typeof r.value==`boolean`?r.value:n},r=e=>{let n=t(e);return!!(n&&n.value===!1&&n.locked)},i=e=>!Ae.has(e),a=!1;i(`video`)&&!n(`video_on_start`,!0)&&T&&(T=!1,to(),window.postMessage({type:`pipelineStatusUpdate`,video:!1},window.location.origin),a=!0);let s=n(`audio_enabled`,!0)===!1;i(`audio`)&&!n(`audio_on_start`,!0)&&!s&&E&&(E=!1,window.postMessage({type:`pipelineStatusUpdate`,audio:!1},window.location.origin),o&&o.postMessage({type:`updatePipelineStatus`,data:{isActive:!1}}),l&&l.setAudioActive&&l.setAudioActive(!1),a=!0),i(`microphone`)&&!n(`microphone_on_demand`,!1)&&n(`microphone_on_start`,!1)&&Me&&!r(`microphone_enabled`)&&To(),i(`webcam`)&&!n(`webcam_on_demand`,!1)&&n(`webcam_on_start`,!1)&&Ne&&!r(`webcam_enabled`)&&Oo();let c=window.localStorage.getItem(`${Rn}_isGamepadEnabled`)!==null;if(i(`gamepad`)&&!c){let e=n(`gamepad_on_start`,!0);Se!==e&&(Se=e,ao(),a=!0)}a&&so()}function so(){let e={type:`sidebarButtonStatusUpdate`,video:T,audio:E,microphone:D,webcam:xe,gamepad:Se};console.log(`Posting sidebarButtonStatusUpdate:`,e),window.postMessage(e,window.location.origin)}function co(e){if(e.origin!==window.location.origin){console.warn(`Received message from unexpected origin: ${e.origin}. Expected ${window.location.origin}. Ignoring.`);return}let t=e.data;if(typeof t!=`object`||!t){console.warn(`Received non-object message via window.postMessage:`,t);return}if(!t.type){console.warn(`Received message without a type property:`,t);return}switch(t.type){case`setVolume`:typeof t.value==`number`&&g&&(_=Math.max(0,Math.min(1,t.value)),g.gain.setValueAtTime(_,m.currentTime));break;case`setMute`:typeof t.value==`boolean`&&g&&(t.value===!0?g.gain.setValueAtTime(0,m.currentTime):g.gain.setValueAtTime(_,m.currentTime));break;case`sidebarVisibilityChanged`:break;case`statsOpen`:vr.setOpen(t.open);break;case`setScaleLocally`:if(G){console.log(`Shared mode: setScaleLocally message ignored (forced true behavior).`);break}typeof t.value==`boolean`?(wr=t.value,Pr(`scaleLocallyManual`,wr),console.log(`Set scaleLocallyManual to ${wr} and persisted.`),window.manual_resolution&&R!==null&&z!==null&&(console.log(`Applying new scaling style in manual mode.`),ua(R,z,wr))):console.warn(`Invalid value received for setScaleLocally:`,t.value);break;case`setSynth`:window.webrtcInput&&typeof window.webrtcInput.setSynth==`function`&&window.webrtcInput.setSynth(t.value);break;case`showVirtualKeyboard`:if(G){console.log(`Shared mode: showVirtualKeyboard message ignored.`);break}console.log(`Received 'showVirtualKeyboard' message.`);let e=document.getElementById(`keyboard-input-assist`),n=document.getElementById(`overlayInput`);e?(e.value=``,e.focus(),console.log(`Focused #keyboard-input-assist element.`),n.addEventListener(`touchstart`,()=>{document.activeElement===e&&e.blur()},{once:!0,passive:!0})):console.error(`Could not find #keyboard-input-assist element to focus.`);break;case`setUseCssScaling`:if(typeof t.value==`boolean`){let e=kt!==t.value;if(kt=t.value,t.persist!==!1&&Pr(`useCssScaling`,kt),console.log(`Set useCssScaling to ${kt}${t.persist===!1?`.`:` and persisted.`}`),window.webrtcInput&&typeof window.webrtcInput.updateCssScaling==`function`&&window.webrtcInput.updateCssScaling(kt),Lt(),e){if(Ri(),window.manual_resolution&&R!=null&&z!=null)ca(R,z),ua(R,z,wr);else if(G)R&&z&&ua(R,z,!0);else if(window.enable_resize!==!1||N===`display2`){let e=window.webrtcInput?window.webrtcInput.getWindowResolution():[window.innerWidth,window.innerHeight],t=Z(e[0]),n=Z(e[1]);ca(t,n),da(t,n)}aa(`useCssScaling changed`)}}else console.warn(`Invalid value received for setUseCssScaling:`,t.value);break;case`setAntiAliasing`:if(typeof t.value==`boolean`){let e=Jt!==t.value;Jt=t.value,Pr(`antiAliasingEnabled`,Jt),console.log(`Set antiAliasingEnabled to ${Jt} and persisted.`),e&&Ri()}else console.warn(`Invalid value received for setAntiAliasing:`,t.value);break;case`setUseBrowserCursors`:typeof t.value==`boolean`?(Zt=t.value,Pr(`use_browser_cursors`,Zt),console.log(`Set use_browser_cursors to ${Zt} and persisted.`),Qt()):console.warn(`Invalid value received for setUseBrowserCursors:`,t.value);break;case`setRawPointerMotion`:typeof t.value==`boolean`?($t=t.value,Pr(`raw_pointer_motion`,$t),console.log(`Set raw_pointer_motion to ${$t} and persisted.`),en()):console.warn(`Invalid value received for setRawPointerMotion:`,t.value);break;case`setMacCmdAsCtrl`:typeof t.value==`boolean`?(tn=t.value,Pr(`mac_cmd_as_ctrl`,tn),console.log(`Set mac_cmd_as_ctrl to ${tn} and persisted.`),nn()):console.warn(`Invalid value received for setMacCmdAsCtrl:`,t.value);break;case`setManualResolution`:if(G){console.log(`Shared mode: setManualResolution message ignored.`);break}let r=parseInt(t.width,10),i=parseInt(t.height,10);if(isNaN(r)||r<=0||isNaN(i)||i<=0){console.error(`Received invalid width/height for setManualResolution:`,t);break}console.log(`Setting manual resolution: ${r}x${i} (logical)`),window.manual_resolution=!0,R=Z(r),z=Z(i),console.log(`Rounded logical resolution to even numbers: ${R}x${z}`),Mr(`manual_width`,R),Mr(`manual_height`,z),Pr(`manual_resolution`,!0),ma(),U(`manual resolution set`),ca(R,z),aa(`manual resolution set`),ua(R,z,wr),Ot(V)&&(console.log(`Clearing VNC stripe decoders due to manual resolution change.`),_a(),c&&c.setTransform(1,0,0,1,0,0),c.clearRect(0,0,s.width,s.height));break;case`resetResolutionToWindow`:if(G){console.log(`Shared mode: resetResolutionToWindow message ignored.`);break}if(console.log(`Resetting resolution to window size.`),window.manual_resolution=!1,R=null,z=null,Mr(`manual_width`,null),Mr(`manual_height`,null),Pr(`manual_resolution`,!1),window.enable_resize!==!1||N===`display2`){let e=window.webrtcInput?window.webrtcInput.getWindowResolution():[window.innerWidth,window.innerHeight];da(Z(e[0]),Z(e[1])),Ot(V)&&(console.log(`Clearing VNC stripe decoders due to resolution reset to window.`),_a(),c&&c.setTransform(1,0,0,1,0,0),c.clearRect(0,0,s.width,s.height))}U(`manual resolution cleared`),fa(),aa(`manual resolution cleared`);break;case`settings`:console.log(`Received settings message:`,t.settings),po(t.settings);break;case`getStats`:console.log(`Received getStats message.`),ho();break;case`clipboardUpdateFromUI`:if(console.log(`Received clipboardUpdateFromUI message.`),G){console.log(`Shared mode: Clipboard write to server blocked.`);break}kn(t.text);break;case`printRequest`:sn(t.url);break;case`clipboardImageUpdate`:if(G){console.log(`Shared mode: Clipboard image write to server blocked.`),lo(`viewers cannot set the clipboard`,`clipboardSkipReadonly`);break}if(!t.imageBlob){lo(`no image selected`,`clipboardSkipNoImage`);break}if(!hn){lo(`image clipboard is disabled on the server (enable_binary_clipboard)`,`clipboardSkipBinaryDisabled`);break}kn(t.imageBlob,t.imageBlob.type||`image/png`,lo).catch(e=>{console.warn(`Failed to send uploaded clipboard image:`,e),lo(`send failed: `+e.message,`clipboardSkipSendFailed`)});break;case`pipelineStatusUpdate`:console.log(`Received pipelineStatusUpdate message:`,t);let a=!1;t.video!==void 0&&T!==t.video&&(T=t.video,a=!0),t.audio!==void 0&&E!==t.audio&&(E=t.audio,a=!0),t.microphone!==void 0&&D!==t.microphone&&(D=t.microphone,a=!0),t.gamepad!==void 0&&Se!==t.gamepad&&(Se=t.gamepad,a=!0),a&&so();break;case`pipelineControl`:console.log(`Received pipeline control message: pipeline=${t.pipeline}, enabled=${t.enabled}`);let u=t.pipeline,d=t.enabled,f=``;if(u===`video`){if(G){console.log(`Shared mode: Video pipelineControl blocked.`);break}if(Ae.add(`video`),T!==d){if(T=d,f=d?`START_VIDEO`:`STOP_VIDEO`,!d){if(console.log(`Client: STOP_VIDEO requested via pipelineControl. Clearing canvas visually. Server will send PIPELINE_RESETTING for full state reset.`),c&&s)try{c.setTransform(1,0,0,1,0,0),c.clearRect(0,0,s.width,s.height)}catch(e){console.error(`Error clearing canvas on STOP_VIDEO request:`,e)}}else if(console.log(`Client: START_VIDEO requested via pipelineControl. Clearing canvas visually. Server will send PIPELINE_RESETTING for full state reset.`),c&&s)try{c.setTransform(1,0,0,1,0,0),c.clearRect(0,0,s.width,s.height)}catch(e){console.error(`Error clearing canvas on START_VIDEO request:`,e)}}}else if(u===`audio`){if(G){console.log(`Shared mode: Audio pipeline control blocked.`);break}if(N!==`primary`){console.log(`Secondary display: Audio control blocked.`);break}if(!A){console.log(`Audio is disabled. Audio pipeline control blocked.`);break}Ae.add(`audio`),E!==d&&(E=d,f=d?`START_AUDIO`:`STOP_AUDIO`,o&&o.postMessage({type:`updatePipelineStatus`,data:{isActive:E}}),l&&l.setAudioActive&&l.setAudioActive(E))}else if(u===`microphone`){if(G){console.log(`Shared mode: Microphone control blocked.`);break}if(!Me){console.log(`Microphone is disabled. Microphone pipeline control blocked.`);break}Ae.add(`microphone`),Pe=!1,d?To():Eo()}else if(u===`webcam`){if(G){console.log(`Shared mode: Webcam control blocked.`);break}if(!Ne){console.log(`Webcam is disabled. Webcam pipeline control blocked.`);break}Ae.add(`webcam`),Fe=!1,d?Oo():ko()}else console.warn(`Received pipelineControl message for unknown pipeline: ${u}`);if(f&&l&&l.readyState===WebSocket.OPEN)try{l.send(f),console.log(`Sent command to server via WebSocket: ${f}`)}catch(e){console.error(`Error sending ${f} to WebSocket:`,e)}break;case`audioDeviceSelected`:if(console.log(`Received audioDeviceSelected message:`,t),G&&t.context===`input`){console.log(`Shared mode: Audio input device selection ignored.`);break}if(!A){console.log(`Audio control flag is disabled. Audio device selection blocked.`);break}let{context:p,deviceId:h}=t;if(!h){console.warn(`Received audioDeviceSelected message without a deviceId.`);break}p===`input`?(L=h,D&&(Eo(),setTimeout(To,150))):p===`output`?(We=h,io()):console.warn(`Unknown context in audioDeviceSelected message: ${p}`);break;case`gamepadControl`:console.log(`Received gamepad control message: enabled=${t.enabled}`);let ee=t.enabled;Ae.add(`gamepad`),Se!==ee&&(Se=ee,Pr(`isGamepadEnabled`,Se),so(),ao());break;case`requestFullscreen`:Ur(!1);break;case`requestGamingMode`:Ur(!0);break;case`command`:if(G){console.log(`Shared mode: Arbitrary command sending to server blocked.`);break}if(!Ln){console.log(`Command sending suppressed: server has command_enabled=false; not sending 'cmd,'.`);break}if(typeof t.value==`string`){let e=t.value;if(console.log(`Received 'command' message with value: "${e}". Forwarding to WebSocket.`),l&&l.readyState===WebSocket.OPEN)try{l.send(`cmd,${e}`),console.log(`Sent command to server via WebSocket: cmd,${e}`)}catch(e){console.error(`Failed to send command via WebSocket:`,e)}else console.warn(`Cannot send command: WebSocket is not open or not available.`)}else console.warn(`Received 'command' message without a string value:`,t);break;case`touchinput:trackpad`:window.webrtcInput&&typeof window.webrtcInput.setTrackpadMode==`function`&&(Rt=!0,Pr(`trackpadMode`,!0),window.webrtcInput.setTrackpadMode(!0),l&&l.readyState===WebSocket.OPEN&&l.send(`SET_NATIVE_CURSOR_RENDERING,1`));break;case`touchinput:touch`:window.webrtcInput&&typeof window.webrtcInput.setTrackpadMode==`function`&&(Rt=!1,Pr(`trackpadMode`,!1),window.webrtcInput.setTrackpadMode(!1),l&&l.readyState===WebSocket.OPEN&&l.send(`SET_NATIVE_CURSOR_RENDERING,0`))}}function lo(e,t){console.warn(`Clipboard image upload skipped: `+e),window.postMessage({type:`fileUpload`,payload:{status:`warning`,fileName:`clipboard-image`,message:e,code:t}},window.location.origin)}function uo(e){let t=Xe()||e&&e.message||String(e);console.error(`Failed to write the session image to the local clipboard:`,e),window.postMessage({type:`fileUpload`,payload:{status:`warning`,fileName:`clipboard-image`,message:t,code:`clipboardImageWriteFailed`}},window.location.origin)}async function fo(e,t=`text/plain`,n=null){let r=(e,t)=>{n&&n(e,t)};if(window.clipboard_enabled===void 0){r(`the session has not reported its clipboard policy yet`,`clipboardSkipNotConnected`);return}if(!window.clipboard_enabled){r(`the server has the clipboard turned off`,`clipboardSkipDisabled`);return}if(!Yt){r(`the client-to-session clipboard is turned off`,`clipboardSkipInDisabled`);return}if(!l||l.readyState!==WebSocket.OPEN){console.warn(`Cannot send clipboard data: WebSocket is not open.`),r(`not connected`,`clipboardSkipNotConnected`);return}let i=e instanceof ArrayBuffer||e instanceof Uint8Array,a;i?a=new Uint8Array(e):(a=new TextEncoder().encode(e),t=`text/plain`);let o=e;if(i)try{let{byteLength:e,hash:t}=await pn.hashBytes(a.slice().buffer);o=Je(e,t)}catch{}if(!_n.shouldSend(o,t)){r(`already the current clipboard`,`clipboardSkipUnchanged`);return}let s=!1;await Ct(a,t,{worker:pn,send:e=>l.send(e),waitDrain:async()=>{for(;l.bufferedAmount>65536;)if(await new Promise(e=>setTimeout(e,20)),l.readyState!==WebSocket.OPEN)return s=!0,!1;return!0},chunkRawBytes:16383,nextTid:()=>++dn}),!s&&l.readyState===WebSocket.OPEN?_n.markSynced(o,t):r(`connection lost during send`,`clipboardSkipSendFailed`)}function po(e,t){let n=t?()=>{}:Mr,r=t?()=>{}:Pr,i=t?()=>{}:Ir;console.log(`Applying settings:`,e);let a=!1;if(e.framerate!==void 0&&($n=parseInt(e.framerate),n(`framerate`,$n),a=!0),e.webcam_encoder!==void 0){let t=String(e.webcam_encoder);qt.includes(t)&&t!==Ie&&(Ie=t,i(`webcam_encoder`,t),M&&(ko(),Oo()))}if(e.encoder!==void 0){let n=e.encoder;if(!t&&!ue(n)){let e=ta(n);console.warn(`This browser has no decoder for ${n}; using the ${e} encoder.`),n=e}V!==n&&(V=n,wi(),i(`encoder`,V),a=!0,n!==`h264enc-striped`&&_a(),yo(),bo(),setTimeout(()=>{if(l&&l.readyState===WebSocket.OPEN)try{l.send(`REQUEST_KEYFRAME`)}catch{}},1500))}if(e.video_crf!==void 0&&(er=parseInt(e.video_crf,10),n(`video_crf`,er),a=!0),e.video_fullcolor!==void 0&&(tr=!!e.video_fullcolor,r(`video_fullcolor`,tr),a=!0,_a()),e.video_streaming_mode!==void 0&&(nr=!!e.video_streaming_mode,r(`video_streaming_mode`,nr),a=!0),e.jpeg_quality!==void 0&&(rr=parseInt(e.jpeg_quality,10),n(`jpeg_quality`,rr),a=!0),e.paint_over_jpeg_quality!==void 0&&(ir=parseInt(e.paint_over_jpeg_quality,10),n(`paint_over_jpeg_quality`,ir),a=!0),e.use_cpu!==void 0&&(ar=!!e.use_cpu,r(`use_cpu`,ar),a=!0,_a()),e.video_paintover_crf!==void 0&&(or=parseInt(e.video_paintover_crf,10),n(`video_paintover_crf`,or),a=!0),e.video_paintover_burst_frames!==void 0&&(sr=parseInt(e.video_paintover_burst_frames,10),n(`video_paintover_burst_frames`,sr),a=!0),e.use_paint_over_quality!==void 0&&(cr=!!e.use_paint_over_quality,r(`use_paint_over_quality`,cr),a=!0),e.scaling_dpi!==void 0&&(zt=parseInt(e.scaling_dpi,10),a=!0,kt&&!window.manual_resolution&&!G&&typeof B==`function`&&B()),e.enable_binary_clipboard!==void 0&&(hn=!!e.enable_binary_clipboard,r(`enable_binary_clipboard`,hn),a=!0),e.keyboard_shortcuts!==void 0&&(rn=!!e.keyboard_shortcuts,r(`keyboard_shortcuts`,rn),an()),e.clipboard_seamless!==void 0&&(Xt=!!e.clipboard_seamless,r(`clipboard_seamless`,Xt)),e.print_auto!==void 0&&(Vr.setAutomatic(e.print_auto),r(`print_auto`,!!e.print_auto)),e.clipboard_in_enabled!==void 0&&(Yt=!!e.clipboard_in_enabled,r(`clipboard_in_enabled`,Yt),a=!0),e.clipboard_out_enabled!==void 0&&(W=!!e.clipboard_out_enabled,r(`clipboard_out_enabled`,W),a=!0),e.use_css_scaling!==void 0){let n={type:`setUseCssScaling`,value:!!e.use_css_scaling,persist:!t};co({origin:window.location.origin,data:n})}if(e.use_browser_cursors!==void 0&&(Zt=!!e.use_browser_cursors,Qt()),e.raw_pointer_motion!==void 0&&($t=!!e.raw_pointer_motion,en()),e.mac_cmd_as_ctrl!==void 0&&(tn=!!e.mac_cmd_as_ctrl,nn()),e.debug!==void 0){br=e.debug,Pr(`debug`,br),console.log(`Applied debug setting: ${br}. Reloading...`),setTimeout(()=>{window.location.reload()},700);return}e.rate_control_mode!==void 0&&(Ar=e.rate_control_mode,i(`rate_control_mode`,Ar),mo(Ar),a=!0),e.video_bitrate!==void 0&&(ur=parseInt(e.video_bitrate,10),n(`video_bitrate`,ur),a=!0),e.audio_bitrate!==void 0&&(lr=parseInt(e.audio_bitrate,10),n(`audio_bitrate`,lr),a=!0),e.force_aligned_resolution!==void 0&&(dr=!!e.force_aligned_resolution,r(`force_aligned_resolution`,dr),a=!0),a&&aa(`handleSettingsMessage`)}function mo(e){e===`cbr`?ur=Y(`video_bitrate`,ur):e===`crf`&&(er=Y(`video_crf`,er))}function ho(){let e={info:window.stream_info,client:window.stream_client,latest:window.stream_stats.latest,clientFps:window.fps,audioBuffer:window.currentAudioBufferSize,audioUnderrunSamples:window.currentAudioUnderrunSamples,audioDropped:window.currentAudioDropped+window.currentAudioWorkletDropped,isVideoPipelineActive:T,isAudioPipelineActive:E,isMicrophoneActive:D,isWebcamActive:xe};e.encoderName=V,e.video_fullcolor=tr,e.video_streaming_mode=nr,window.parent.postMessage({type:`stats`,data:e},window.location.origin),console.log(`Sent stats message via window.postMessage:`,e)}function go(){if(!Io())return;let a=he()+`/`;On=st({isChromium:gn,getDeferredWriteInFlight:()=>vn.getInFlight(),isSharedMode:()=>G,canSync:()=>!!window.clipboard_enabled&&Xt,canRead:()=>!!Yt,binaryEnabled:()=>!!hn,sendClipboardData:(e,t,n)=>fo(e,t,n)});let ee=()=>On.readAndSend(),y=()=>On.maybeInitial();gn&&window.addEventListener(`focus`,()=>{ee()}),ft({isChromium:gn,clipboardSync:_n,sendClipboardData:(e,t)=>fo(e,t),canSync:()=>!G&&!!window.clipboard_enabled&&Xt,canRead:()=>!!Yt,canWrite:()=>!!W,binaryEnabled:()=>!!hn,getSendInFlight:()=>On.getSendInFlight(),getDeferredWriteInFlight:()=>vn.getInFlight()}).wire();let b=()=>{if(c&&s)try{c.setTransform(1,0,0,1,0,0),c.clearRect(0,0,s.width,s.height)}catch(e){console.error(`Error clearing canvas on visibility change:`,e)}},ae=null,x=!1;document.addEventListener(`visibilitychange`,async()=>{if(G){if(!l||l.readyState!==WebSocket.OPEN)return;if(document.hidden){if(!In){In=!0;try{l.send(`STOP_VIDEO`)}catch{}b(),window.postMessage({type:`pipelineStatusUpdate`,video:!1},window.location.origin),console.log(`Shared mode: tab hidden, sent STOP_VIDEO to pause this viewer's feed.`)}}else{if(In){In=!1;try{l.send(`START_VIDEO`)}catch{}Ua(),window.postMessage({type:`pipelineStatusUpdate`,video:!0},window.location.origin),console.log(`Shared mode: tab visible, sent START_VIDEO to resume this viewer's feed.`)}Dt===null&&(console.log(`Tab is visible again, re-acquiring Wake Lock.`),await Qa())}return}if(document.hidden)ae===null&&(ae=setTimeout(()=>{if(ae=null,document.hidden&&(console.log(`Tab is hidden, stopping video pipeline if active.`),l&&l.readyState===WebSocket.OPEN&&T&&(l.send(`STOP_VIDEO`),T=!1,x=!0,window.postMessage({type:`pipelineStatusUpdate`,video:!1},window.location.origin),console.log(`Tab hidden: Sent STOP_VIDEO. Clearing canvas visually. Server will send PIPELINE_RESETTING for full state reset.`),c&&s)))try{c.setTransform(1,0,0,1,0,0),c.clearRect(0,0,s.width,s.height)}catch(e){console.error(`Error clearing canvas on tab hidden:`,e)}},250));else{if(ae!==null&&(clearTimeout(ae),ae=null),!x&&T&&Va(),x&&(x=!1,console.log(`Tab is visible, resuming the video pipeline paused on hide.`),l&&l.readyState===WebSocket.OPEN&&(l.send(`START_VIDEO`),T=!0,Ua(),window.postMessage({type:`pipelineStatusUpdate`,video:!0},window.location.origin),console.log(`Tab visible: Sent START_VIDEO. Clearing canvas visually. Server will send PIPELINE_RESETTING for full state reset.`),c&&s)))try{c.setTransform(1,0,0,1,0,0),c.clearRect(0,0,s.width,s.height)}catch(e){console.error(`Error clearing canvas on tab visible/start:`,e)}Dt===null&&(console.log(`Tab is visible again, re-acquiring Wake Lock.`),await Qa())}});let oe={imagedecoder:async e=>{let t=new ImageDecoder({data:e,type:`image/jpeg`});try{return(await t.decode()).image}finally{try{t.close()}catch{}}},bitmap:e=>createImageBitmap(new Blob([e],{type:`image/jpeg`})),img:e=>{let t=URL.createObjectURL(new Blob([e],{type:`image/jpeg`})),n=new Image;return n.src=t,n.decode().then(()=>n,e=>{throw URL.revokeObjectURL(t),e}).then(e=>(URL.revokeObjectURL(t),e))}};function ce(e,t){let n=new TextEncoder().encode(`sel`+t.toString(36).padStart(9,`0`)),r=new Uint8Array(e),i=new Uint8Array(r.length+4+n.length);i[0]=255,i[1]=216,i[2]=255,i[3]=254;let a=n.length+2;return i[4]=a>>8&255,i[5]=a&255,i.set(n,6),i.set(r.subarray(2),6+n.length),i}let ue=null,de=null;async function fe(){let e=Object.keys(oe).filter(e=>(e!==`imagedecoder`||typeof ImageDecoder<`u`)&&(e!==`bitmap`||typeof createImageBitmap==`function`)&&(e!==`img`||typeof Image<`u`));if(e.length<=1)return e[0]||null;let t=1920,n,r;try{n=[];for(let e=0;e<8;e++){let r=document.createElement(`canvas`);r.width=t,r.height=136;let i=r.getContext(`2d`);i.fillStyle=`#204080`,i.fillRect(0,0,t,136),i.lineWidth=3,i.strokeStyle=`#c8c828`;for(let n=0;n<t;n+=40)i.beginPath(),i.moveTo(n+e,0),i.lineTo(n+e,136),i.stroke();let a=await new Promise(e=>r.toBlob(e,`image/jpeg`,.75));n.push(await a.arrayBuffer())}r=document.createElement(`canvas`),r.width=t,r.height=1088}catch{return e[0]}let i=r.getContext(`2d`),a=0;for(let t of e)try{let e=await oe[t](ce(n[0],a++));i.drawImage(e,0,0);try{e.close()}catch{}}catch{}let o=null;for(let t of e)try{let e=performance.now();for(let e=0;e<2;e++)await Promise.all(n.map(async(e,n)=>{let r=await oe[t](ce(e,a++));i.drawImage(r,0,n*136);try{r.close()}catch{}}));let r=performance.now()-e;(!o||r<o.ms)&&(o={name:t,ms:r})}catch{}return o?o.name:e[0]}async function C(e,t,n){be++;try{let r=ue;if(!r&&(de||=fe().then(e=>(ue=e,e&&console.log(`[jpeg] decoding stripes through ${e}`),e)).catch(()=>null),r=typeof ImageDecoder<`u`?`imagedecoder`:typeof createImageBitmap==`function`?`bitmap`:null,!r)){console.warn(`No JPEG decoder available (ImageDecoder and createImageBitmap both missing).`);return}ve.push({image:await oe[r](t),startY:e,frameId:n})}catch(n){console.error(`Error decoding JPEG stripe:`,n,`startY:`,e,`dataLength:`,t.byteLength)}finally{be--}}let pe=!1;function w(){pe||(pe=!0,requestAnimationFrame(()=>{pe=!1,me()}))}function me(){if(!s||!c){w();return}if(S||Yr){let e=H(V);S&&!e&&Ii(),Yr&&!e&&!ci&&ki()}let e=G?1:window.devicePixelRatio||1;if(G&&R&&z&&R>0&&z>0){let t=Z(R*e),n=Z(z*e);(s.width!==t||s.height!==n)&&(console.log(`Shared mode (paintVideoFrame): Canvas buffer ${s.width}x${s.height} out of sync with expected physical ${t}x${n} (logical: ${R}x${z}). Re-applying style.`),ua(R,z,!0))}let t=!1;if(H(V)){let e=!1;if(xa.length>0){let t=xa.length-1;for(let e=0;e<t;e++)try{xa[e].frame.close()}catch{}let n=xa[t].frame;if(xa.length=0,k=performance.now(),!(Kr&&xi(n))&&!(qr&&ji(n))){s.width>0&&s.height>0&&c.drawImage(n,0,0);try{n.close()}catch{}}e=!0}e&&!xr&&no()}else if(V===`h264enc-striped`){qr&&!Q&&!si&&pi<3&&Oi();let e=!1,t=Ia(),n=ya(),r=n&&Oa.settled(),i=!1;if(t)for(let t of xa){let n=t.frameId;!r&&wa!==null&&n!==wa&&Ta&&(Ra(),Ta=!1,e=!0),wa=n,t.yPos+t.frame.displayHeight>=s.height&&(i=!0),La(t.frame,t.yPos),Ta=!0}else for(let e of xa)try{e.frame.close()}catch{}xa=[],n&&(r||i)&&Ta&&s.width>0&&s.height>0&&(Ra(),Ta=!1,e=!0),e&&!xr&&no()}else if(V===`jpeg`){qr&&!Q&&!si&&pi<3&&Oi();let e=be===0,n=e&&Oa.settled(),r=!1;if(c&&ve.length>0){if(s.width===0||s.height===0||s.width===300&&s.height===150){let e=ve[0],t=e&&e.image&&(e.image.displayHeight??e.image.height),n=e&&e.image&&(e.image.displayWidth??e.image.width);e&&e.image&&(e.startY+t>s.height||n>s.width)&&console.warn(`[paintVideoFrame] Canvas dimensions (${s.width}x${s.height}) may be too small for JPEG stripes.`)}let e=Ia();for(;ve.length>0;){let i=ve.shift();if(i&&i.image){let a=i.frameId,o=za[i.startY];if(a!==void 0&&o!==void 0){let e=o-a&65535;if(e>0&&e<=256){try{i.image.close()}catch{}continue}}try{if(e){!n&&a!==void 0&&wa!==null&&a!==wa&&Ta&&(Ra(),Ta=!1),a!==void 0&&(wa=a);let e=i.image.displayHeight??i.image.height;i.startY+e>=s.height&&(r=!0),La(i.image,i.startY),Ta=!0}else try{i.image.close()}catch{}a!==void 0&&(za[i.startY]=a),t=!0}catch(e){if(console.error(`[paintVideoFrame] Error drawing JPEG segment:`,e,i),i.image&&typeof i.image.close==`function`)try{i.image.close()}catch{}}}}t&&(xr||(no(),!Cr&&!G&&ro()))}e&&(n||r)&&Ta&&c&&s.width>0&&s.height>0&&(Ra(),Ta=!1)}w()}function ge(){if(!o||!v)return;let e=new MessageChannel;try{v.postMessage({type:`pcmPort`,port:e.port1},[e.port1]),o.postMessage({type:`pcmPort`,port:e.port2},[e.port2])}catch(e){console.warn(`Could not connect the audio decoder to the worklet directly:`,e)}}function _e(){if(!o||!l||typeof l.connectAudio!=`function`)return;let e=new MessageChannel;try{o.postMessage({type:`audioIn`,port:e.port1},[e.port1]),l.connectAudio(e.port2)}catch(e){console.warn(`Could not connect the socket worker to the audio decoder:`,e)}}let ye=`
let ws = null, audioPort = null, audioOn = true, primary = true;
let lastTick = 0;

// Encoded webcam frames sent while the socket was down would corrupt the
// server's decoder as deltas; held back until a keyframe restores the chain.
let webcamChainBroken = false;
// Video divert: 0x03/0x04 go straight to the video worker while the page
// keeps this on, and the newest frame id is acked from here on the same
// cadence the page would use, so pacing and RTT stay honest through a stall.
// Full frames ack on receipt; the striped modes ack the id the video worker
// reports presented, so a client that cannot render sheds load. An unchanged
// id is repeated on the heartbeat cadence, as the page path does.
let videoPort = null, videoDivert = false, videoAck = false, videoAckSource = 'receive';
let videoLastId = -1, videoLastIdAt = 0, videoAckedId = -1, videoAckSentAt = 0, videoAckTimer = null;

// The page gates its own sends on what this reports, so a socket left holding
// bytes has to be reported as it drains: reporting only on send would freeze
// the page's view at the moment of a message too big for its gate, and nothing
// would ever send again to correct it.
let bufferedTimer = null;
function reportBuffered() {
  self.postMessage({ type: 'buffered', amount: ws ? ws.bufferedAmount : 0 });
  if (!ws || ws.bufferedAmount === 0) {
    if (bufferedTimer) { clearInterval(bufferedTimer); bufferedTimer = null; }
    return;
  }
  if (bufferedTimer) return;
  bufferedTimer = setInterval(() => {
    self.postMessage({ type: 'buffered', amount: ws ? ws.bufferedAmount : 0 });
    if (!ws || ws.bufferedAmount === 0) { clearInterval(bufferedTimer); bufferedTimer = null; }
  }, 20);
}

function syncVideoAckTimer() {
  const want = videoDivert && videoAck;
  if (want && !videoAckTimer) {
    videoAckTimer = setInterval(() => {
      if (videoLastId < 0) return;
      if (!ws || ws.readyState !== 1) return;
      const now = performance.now();
      if (videoLastId === videoAckedId && now - videoAckSentAt < ${xt}) return;
      // The hold: how long the id waited on this tick, which a backgrounded
      // tab clamps to a second. The server subtracts it, so the round trip it
      // reports stays the path's rather than this timer's.
      const held = Math.max(0, Math.round(now - videoLastIdAt));
      try { ws.send('CLIENT_FRAME_ACK ' + videoLastId + ' ' + held); videoAckedId = videoLastId; videoAckSentAt = now; } catch (err) {}
    }, 50);
  } else if (!want && videoAckTimer) {
    clearInterval(videoAckTimer);
    videoAckTimer = null;
  }
}

self.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'audioPort') { audioPort = m.port; return; }
  if (m.type === 'audioState') { audioOn = !!m.active; return; }
  if (m.type === 'videoPort') {
    videoPort = m.port;
    videoPort.onmessage = (ev) => {
      const pm = ev.data;
      if (pm && pm.presentedId !== undefined) { videoLastId = pm.presentedId; videoLastIdAt = performance.now(); }
    };
    return;
  }
  if (m.type === 'videoState') {
    videoDivert = !!m.divert;
    videoAck = !!m.ack;
    videoAckSource = m.ackSource || 'receive';
    syncVideoAckTimer();
    return;
  }
  if (m.type === 'videoAckReset') {
    // The server's ids restart; the heartbeat must not repeat the old one.
    videoLastId = -1; videoAckedId = -1; videoAckSentAt = 0;
    return;
  }
  if (m.type === 'sendPort') {
    // Fully framed messages from another worker (the microphone encoder).
    m.port.onmessage = (ev) => {
      if (!ws || ws.readyState !== 1) return;
      try { ws.send(ev.data); } catch (err) { /* onclose reports */ }
    };
    return;
  }
  if (m.type === 'webcamPort') {
    m.port.onmessage = (ev) => {
      const f = ev.data;
      if (!ws || ws.readyState !== 1) { webcamChainBroken = true; return; }
      if (webcamChainBroken && !f.keyframe) {
        try { ev.target.postMessage({ needKeyframe: true }); } catch (err) {}
        return;
      }
      const msg = new Uint8Array(3 + f.buffer.byteLength);
      msg[0] = 0x06;
      msg[1] = f.codecId;
      msg[2] = (f.keyframe ? 0x01 : 0x00) | ((((f.rotation || 0) / 90) & 0x03) << 1) | (f.flip ? 0x08 : 0x00);
      msg.set(new Uint8Array(f.buffer), 3);
      try {
        ws.send(msg.buffer);
        if (f.keyframe) webcamChainBroken = false;
      } catch (err) { webcamChainBroken = true; }
    };
    return;
  }
  if (m.type === 'open') {
    primary = m.primary !== false;
    ws = new WebSocket(m.url);
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => self.postMessage({ type: 'open' });
    ws.onerror = () => self.postMessage({ type: 'error' });
    ws.onclose = (ev) => {
      self.postMessage({ type: 'close', code: ev.code, reason: ev.reason, wasClean: ev.wasClean });
      ws = null;
    };
    ws.onmessage = (ev) => {
      const d = ev.data;
      if (audioPort && audioOn && primary && d instanceof ArrayBuffer &&
          d.byteLength > 2 && new Uint8Array(d, 0, 1)[0] === 0x01) {
        // The page still owns the AudioContext, which only it can resume, so it
        // is told audio is arriving -- rarely, since this runs per packet.
        const now = Date.now();
        if (now - lastTick > 1000) { lastTick = now; self.postMessage({ type: 'audioTick' }); }
        audioPort.postMessage({ buffer: d }, [d]);
        return;
      }
      if (videoPort && videoDivert && d instanceof ArrayBuffer && d.byteLength > 6) {
        const t = new Uint8Array(d, 0, 1)[0];
        if (t === 0x03 || (t === 0x04 && d.byteLength > 10)) {
          if (videoAckSource === 'receive') {
            const head = new Uint8Array(d, 2, 2);
            videoLastId = (head[0] << 8) | head[1];
            videoLastIdAt = performance.now();
          }
          videoPort.postMessage(d, [d]);
          return;
        }
      }
      if (d instanceof ArrayBuffer) self.postMessage({ type: 'message', data: d }, [d]);
      else self.postMessage({ type: 'message', data: d });
    };
    return;
  }
  if (!ws) return;
  if (m.type === 'send') {
    try { ws.send(m.data); } catch (err) { /* a closing socket reports through onclose */ }
    reportBuffered();
    return;
  }
  if (m.type === 'close') { try { ws.close(m.code, m.reason); } catch (err) {} return; }
};
`;class xe{constructor(e,t){this.readyState=WebSocket.CONNECTING,this.binaryType=`arraybuffer`,this.onopen=this.onmessage=this.onerror=this.onclose=null,this._listeners={},this._buffered=0;let n=new Blob([ye],{type:`text/javascript`}),r=URL.createObjectURL(n);this._worker=new Worker(r),URL.revokeObjectURL(r),this._worker.onmessage=e=>{let t=e.data;if(t.type===`message`){let e={data:t.data};this.onmessage&&this.onmessage(e),this._emit(`message`,e);return}if(t.type===`buffered`){this._buffered=t.amount;return}if(t.type===`audioTick`){m&&m.state!==`running`&&m.resume().catch(()=>{});return}if(t.type===`open`){this.readyState=WebSocket.OPEN,this.onopen&&this.onopen(),this._emit(`open`,{});return}if(t.type===`error`){this.onerror&&this.onerror(t),this._emit(`error`,t);return}if(t.type===`close`){this.readyState=WebSocket.CLOSED,this.onclose&&this.onclose(t),this._emit(`close`,t),this._retire();return}},this._worker.postMessage({type:`open`,url:e,primary:t})}get bufferedAmount(){return this._buffered}addEventListener(e,t){(this._listeners[e]||(this._listeners[e]=[])).push(t)}removeEventListener(e,t){let n=this._listeners[e];if(!n)return;let r=n.indexOf(t);r>=0&&n.splice(r,1)}_emit(e,t){let n=this._listeners[e];if(n)for(let e of n.slice())try{e(t)}catch{}}connectAudio(e){try{this._worker.postMessage({type:`audioPort`,port:e},[e])}catch{}}setAudioActive(e){try{this._worker.postMessage({type:`audioState`,active:e})}catch{}}connectSend(e){try{this._worker.postMessage({type:`sendPort`,port:e},[e])}catch{}}connectWebcam(e){try{this._worker.postMessage({type:`webcamPort`,port:e},[e])}catch{}}connectVideo(e){try{this._worker.postMessage({type:`videoPort`,port:e},[e])}catch{}}setVideoDivert(e,t){let n=!!e&&N===`primary`&&!G;try{this._worker.postMessage({type:`videoState`,divert:!!e,ack:n,ackSource:t||`receive`})}catch{}}resetVideoAck(){try{this._worker.postMessage({type:`videoAckReset`})}catch{}}send(e){if(this.readyState!==WebSocket.OPEN)return;if(typeof e==`string`){this._buffered+=e.length,this._worker.postMessage({type:`send`,data:e});return}let t=e instanceof ArrayBuffer?e:ArrayBuffer.isView(e)?e.buffer.slice(e.byteOffset,e.byteOffset+e.byteLength):e;this._buffered+=t.byteLength||0,this._worker.postMessage({type:`send`,data:t},[t])}close(e,t){this.readyState=WebSocket.CLOSING;try{this._worker.postMessage({type:`close`,code:e,reason:t})}catch{}this._retire()}_retire(){this._retiring||(this._retiring=!0,setTimeout(()=>{try{this._worker.terminate()}catch{}},2e3))}}async function De(){if(N!==`primary`){console.log(`Secondary display: Audio pipeline initialization skipped.`);return}if(!window.isAudioInitializing){window.isAudioInitializing=!0;try{if(o){console.warn(`Terminating existing audio worker during init.`);let e=o;o=null,e.postMessage({type:`close`}),await new Promise(e=>setTimeout(e,50)),e.terminate()}if(m){console.warn(`Closing existing AudioContext during init.`);try{await m.close()}catch(e){console.error(e)}m=null,h=null,v=null}m||(m=new(window.AudioContext||window.webkitAudioContext)({sampleRate:48e3}),console.log(`Playback AudioContext initialized. Actual sampleRate:`,m.sampleRate,`Initial state:`,m.state),m.onstatechange=()=>{m&&(console.log(`Playback AudioContext state changed to: ${m.state}`),m.state===`running`&&io())});try{let e=new Blob([`
        class AudioFrameProcessor extends AudioWorkletProcessor {
            constructor(options) {
                super();
                this.channels = (options && options.processorOptions && options.processorOptions.channels) || 2;
                this.audioBufferQueue = [];
                this.currentAudioData = null;
                this.currentDataOffset = 0;

                // Adaptive jitter depth under a fixed drop-oldest ceiling.
                // Output starts once target packets are queued; each
                // mid-stream underrun deepens the target by one, a clean
                // stretch decays it back, and standing depth above it is
                // trimmed a packet at a time -- so steady latency sits at the
                // smallest depth the delivery path has recently proven to
                // hold, and a jittery one (a stall upstream, Gecko routing
                // the socket through the page's thread) buys the depth it
                // demonstrably needs.
                this.TARGET_MIN = 2;
                this.TARGET_MAX = 6;
                this.MAX_BUFFER_PACKETS = 8;
                this.target = this.TARGET_MIN;
                this.priming = true;
                this.overCount = 0;
                this.cleanCount = 0;
                // Packets left at the moment one is pulled, tracked at its
                // minimum: the slack that proves a shallower target safe.
                this.shiftSlackMin = Infinity;

                // Concealment counters: zero-filled samples output on underrun, and
                // packets dropped by the drop-oldest ring when the queue overflows.
                this.underrunSamples = 0;
                this.droppedOldest = 0;
                // Output RMS accumulator (channel 0), reported with each stats reply.
                this._levelAcc = 0;
                this._levelCount = 0;

                this.enqueue = (buffer) => {
                    const pcmData = new Float32Array(buffer);
                    if (this.audioBufferQueue.length >= this.MAX_BUFFER_PACKETS) {
                        this.audioBufferQueue.shift();
                        this.droppedOldest++;
                    }
                    this.audioBufferQueue.push(pcmData);
                };
                this.port.onmessage = (event) => {
                    if (event.data.audioData) {
                        this.enqueue(event.data.audioData);
                    } else if (event.data.type === 'pcmPort' && event.data.port) {
                        // The decoder worker's own line in: decoded packets then
                        // reach this processor whatever the page's thread is doing.
                        event.data.port.onmessage = (m) => {
                            if (m.data && m.data.audioData) this.enqueue(m.data.audioData);
                        };
                    } else if (event.data.type === 'getBufferSize') {
                        const bufferMillis = this.audioBufferQueue.reduce((total, buf) => total + (buf.length / this.channels / sampleRate) * 1000, 0);
                        const level = this._levelCount > 0 ? Math.sqrt(this._levelAcc / this._levelCount) : 0;
                        this._levelAcc = 0;
                        this._levelCount = 0;
                        this.port.postMessage({
                            type: 'audioBufferSize',
                            size: this.audioBufferQueue.length,
                            durationMs: bufferMillis,
                            underrunSamples: this.underrunSamples,
                            droppedOldest: this.droppedOldest,
                            level: level
                        });
                    }
                };
            }

            process(inputs, outputs, parameters) {
                const output = outputs[0];
                if (!output || !output[0]) {
                    return true;
                }
                // The decoder hands interleaved f32 data with this.channels channels;
                // de-interleave into however many output channels were configured.
                const chans = output.length;
                const samplesPerBuffer = output[0].length;
                const zeroFill = (from) => {
                    for (let c = 0; c < chans; c++) output[c].fill(0, from);
                };

                if (this.priming) {
                    if (this.audioBufferQueue.length < this.target) {
                        zeroFill(0);
                        return true;
                    }
                    this.priming = false;
                }

                if (this.audioBufferQueue.length === 0 && this.currentAudioData === null) {
                    zeroFill(0);
                    // Full-buffer concealment.
                    this.underrunSamples += samplesPerBuffer;
                    this._reprime();
                    return true;
                }

                let data = this.currentAudioData;
                let offset = this.currentDataOffset;

                for (let sampleIndex = 0; sampleIndex < samplesPerBuffer; sampleIndex++) {
                    if (!data || offset >= data.length) {
                        if (this.audioBufferQueue.length > 0) {
                            const slack = this.audioBufferQueue.length - 1;
                            if (slack < this.shiftSlackMin) this.shiftSlackMin = slack;
                            data = this.currentAudioData = this.audioBufferQueue.shift();
                            offset = this.currentDataOffset = 0;
                        } else {
                            this.currentAudioData = null;
                            this.currentDataOffset = 0;
                            zeroFill(sampleIndex);
                            // Partial concealment.
                            this.underrunSamples += (samplesPerBuffer - sampleIndex);
                            this._reprime();
                            return true;
                        }
                    }

                    for (let c = 0; c < chans; c++) {
                        output[c][sampleIndex] = offset < data.length ? data[offset++] : output[0][sampleIndex];
                    }
                    const s0 = output[0][sampleIndex];
                    this._levelAcc += s0 * s0;
                    this._levelCount++;
                }

                this.currentDataOffset = offset;
                if (data && offset >= data.length) {
                    this.currentAudioData = null;
                    this.currentDataOffset = 0;
                }

                // Reclaims latency: depth held above target is a standing
                // delay, dropped one packet per window; long clean runs
                // shrink the target.
                if (this.audioBufferQueue.length > this.target) {
                    if (++this.overCount >= 250) {
                        this.audioBufferQueue.shift();
                        this.droppedOldest++;
                        this.overCount = 0;
                    }
                } else {
                    this.overCount = 0;
                }
                if (++this.cleanCount >= 2000) {
                    this.cleanCount = 0;
                    // Decay only over proven slack: a whole packet must have
                    // stayed spare at every pull, else a shallower target is
                    // a periodic audible probe rather than a reclaim.
                    if (this.target > this.TARGET_MIN && this.shiftSlackMin >= 2) this.target--;
                    this.shiftSlackMin = Infinity;
                }

                return true;
            }

            /** Restarts priming after an underrun, one packet deeper. */
            _reprime() {
                this.priming = true;
                this.target = Math.min(this.target + 1, this.TARGET_MAX);
                this.overCount = 0;
                this.cleanCount = 0;
                this.shiftSlackMin = Infinity;
            }
        }
        registerProcessor('audio-frame-processor', AudioFrameProcessor);
      `],{type:`text/javascript`}),t=URL.createObjectURL(e);await m.audioWorklet.addModule(t),URL.revokeObjectURL(t);let n=So();if(n>2)try{m.destination.channelCount=Math.min(n,m.destination.maxChannelCount||n)}catch(e){console.warn(`Could not widen audio destination:`,e)}h=new AudioWorkletNode(m,`audio-frame-processor`,{numberOfOutputs:1,outputChannelCount:[n],processorOptions:{channels:n}}),v=h.port,ge(),v.onmessage=e=>{e.data.type===`audioBufferSize`&&(window.currentAudioBufferSize=e.data.size,window.currentAudioBufferDuration=e.data.durationMs,e.data.underrunSamples!==void 0&&(window.currentAudioUnderrunSamples=e.data.underrunSamples),e.data.droppedOldest!==void 0&&(window.currentAudioWorkletDropped=e.data.droppedOldest),e.data.level!==void 0&&(window.currentAudioLevel=Math.min(100,Math.round(e.data.level*141))))},g=m.createGain(),g.gain.value=_,h.connect(g),g.connect(m.destination),console.log(`Playback AudioWorkletProcessor initialized and connected through a GainNode for volume control.`),await io();let r=new Blob([wo],{type:`application/javascript`}),i=URL.createObjectURL(r);if(o=new Worker(i),URL.revokeObjectURL(i),ge(),_e(),o.onmessage=e=>{let{type:t,reason:n,message:r}=e.data;if(t===`decoderInitFailed`)console.error(`[Main] Audio Decoder Worker failed to initialize: ${n}`);else if(t===`decoderError`)console.error(`[Main] Audio Decoder Worker reported error: ${r}`);else if(t===`decoderInitialized`)console.log(`[Main] Audio Decoder Worker confirmed its decoder is initialized.`);else if(t===`decodedAudioData`){let t=e.data.pcmBuffer;t&&v&&m&&m.state===`running`&&window.currentAudioBufferSize<10&&v.postMessage({audioData:t},[t])}},o.onerror=e=>{console.error(`[Main] Uncaught error in Audio Decoder Worker:`,e.message,e),o&&=(o.terminate(),null)},v){let e=So();o.postMessage({type:`init`,data:{initialPipelineStatus:E,channels:e,description:e>2?Co(e):null}}),console.log(`[Main] Audio Decoder Worker created and init message sent.`)}else console.error(`[Main] audioWorkletProcessorPort is null, cannot initialize audioDecoderWorker correctly.`)}catch(e){console.error(`Error initializing Playback AudioWorklet:`,e),m&&m.state!==`closed`&&m.close(),m=null,h=null,v=null}}finally{window.isAudioInitializing=!1}}}async function Oe(){o?(console.log(`[Main] Requesting Audio Decoder Worker to reinitialize its decoder.`),o.postMessage({type:`reinitialize`})):(console.warn(`[Main] Cannot initialize decoder audio: Audio Decoder Worker not available. Call initializeAudio() first.`),u===`websockets`&&!m&&(console.log(`[Main] Audio context missing, attempting to initialize full audio pipeline for websockets.`),await De()))}let F=location.protocol===`http:`?`ws://`:`wss://`,Re=new URL(`${F}${window.location.host}${a}`);if(p)Re.search=`?token=${Nn}`;else if(G){let e=new URLSearchParams;if(e.set(`role`,`viewer`),An&&An.startsWith(`player`)){let t=An.replace(`player`,``);t>=2&&t<=4&&e.set(`slot`,t)}Re.search=e.toString()}Re.pathname+=`api/websockets`;let I=Mn.get(`socket_worker`),ze=I===null?X(`socket_worker`,!0):I.toLowerCase()===`true`;try{if(!ze)throw Error(`socket_worker=false`);l=new xe(Re.href,N===`primary`)}catch(e){ze&&console.warn(`[websockets] socket worker unavailable, reading on the page:`,e),l=new WebSocket(Re.href),l.binaryType=`arraybuffer`}window.selkiesTransport=l,_e(),ci=!1,Ci();let Be=()=>{if(!ci&&l&&l.readyState===WebSocket.OPEN)try{let e=(V===`jpeg`||V===`h264enc-striped`)&&Ea!==null,t=e?Ea:O,n=e?Da:Ce,r=performance.now();if(t!==-1&&t!==null&&(t!==we||r-Te>=xt)){let e=Math.max(0,Math.round(r-n));l.send(`CLIENT_FRAME_ACK ${t} ${e}`),we=t,Te=r}}catch(e){console.error(`[Backpressure] Error sending frame ACK:`,e)}},Ve=()=>{if(v&&v.postMessage({type:`getBufferSize`}),G)return;let e=performance.now(),t=e-Dr,n=e-Or,r=1e3,i=Er.size+ui;if(i>0){if(t>=r){let n=i*1e3/t;window.fps=Math.round(n),Er.clear(),ui=0,Dr=e,Tr=0,Or=e}}else if(Tr>0){if(n>=r){let t=Tr*1e3/n;window.fps=Math.round(t),Tr=0,Or=e,Dr=e}}else(t>=r||n>=r)&&(window.fps=0,Or=e,Dr=e);Zn(),Qn()};l.onopen=async()=>{console.log(`[websockets] Connection opened!`),await Bi(),await se===`avcc`&&console.info(`[Selkies] H.264 decodes here with an avcC description; frames are reframed for it.`),_o=!0;try{sessionStorage.removeItem(`selkies_mode_flip`)}catch{}if(fr=`connected_waiting_mode`,pr=`Connection established. Waiting for server mode...`,Gr(),typeof DecompressionStream<`u`)try{l.send(`_gz,1`)}catch{}if(window.postMessage({type:`trackpadModeUpdate`,enabled:Rt},window.location.origin),G)console.log(`Shared mode: WebSocket opened. Waiting for 'MODE websockets' from server to start identification sequence.`);else{let e=`${Rn}_`,t={},n=Nt(),r=[`framerate`,`video_crf`,`encoder`,`manual_resolution`,`audio_bitrate`,`video_fullcolor`,`video_streaming_mode`,`jpeg_quality`,`paint_over_jpeg_quality`,`use_cpu`,`video_paintover_crf`,`video_paintover_burst_frames`,`use_paint_over_quality`,`scaling_dpi`,`enable_binary_clipboard`,`rate_control_mode`,`video_bitrate`,`force_aligned_resolution`],i=[`manual_resolution`,`video_fullcolor`,`video_streaming_mode`,`use_cpu`,`use_paint_over_quality`,`enable_binary_clipboard`,`force_aligned_resolution`],a=[`framerate`,`video_crf`,`audio_bitrate`,`jpeg_quality`,`paint_over_jpeg_quality`,`video_paintover_crf`,`video_paintover_burst_frames`,`scaling_dpi`,`video_bitrate`];for(let n in localStorage)if(Object.hasOwnProperty.call(localStorage,n)&&n.startsWith(e)){let o=n.substring(e.length),s=`_${N}`,c=N!==`primary`&&o.endsWith(s),l=c?o.slice(0,-s.length):o;if(!c&&N!==`primary`&&P.includes(l))continue;if(r.includes(l)){let e=localStorage.getItem(n);if(i.includes(l))e=e===`true`;else if(a.includes(l)&&(e=parseInt(e,10),isNaN(e)))continue;t[l]=e}}if(manual_resolution&&R!=null&&z!=null)t.manual_resolution=!0,t.manual_width=Z(R),t.manual_height=Z(z);else{let e=document.querySelector(`.video-container`),r=e?e.getBoundingClientRect():{width:window.innerWidth,height:window.innerHeight};t.manual_resolution=!1,t.initialClientWidth=Z(r.width*n),t.initialClientHeight=Z(r.height*n)}t.scaling_dpi===void 0&&(t.scaling_dpi=Ut()),Cn&&(t.keyboardLayout=Cn),t.useCssScaling=kt,t.displayId=N,t.displayScale=oa(n),Ft=n,N===`display2`&&(t.displayPosition=Le),t.audioRedundancy=!0;try{let e=`SETTINGS,${JSON.stringify(t)}`;l.send(e),console.log(`[websockets] Sent initial settings (resolutions are physical) to server:`,t)}catch(e){console.error(`[websockets] Error constructing or sending initial settings:`,e)}}wn.armLegacyWindow(5e3),l.send(`cr`),console.log(`[websockets] Sent initial clipboard request (cr) to server (cache-only).`),Ae.clear(),j=!1,je=!1,T=!0,E=N===`primary`,window.postMessage({type:`pipelineStatusUpdate`,video:!0,audio:E},window.location.origin),Ye===null&&(Ye=setInterval(Ve,500),console.log(`[websockets] Started client metrics every 500ms.`)),G||(D=!1,$e===null&&($e=setInterval(Be,50),console.log(`[websockets] Started sending backpressure ACKs every 50ms.`)))};let He=Promise.resolve(),Ue=0,L=async e=>{let t=new Response(new Blob([e]).stream().pipeThrough(new DecompressionStream(`gzip`)));return new TextDecoder().decode(await t.arrayBuffer())},We=!1,Ge=Promise.resolve(),Ke=0,qe=async e=>{let t=await new Response(new Blob([e]).stream().pipeThrough(new CompressionStream(`gzip`))).arrayBuffer(),n=new Uint8Array(t.byteLength+1);return n[0]=5,n.set(new Uint8Array(t),1),n.buffer},Xe=l.send.bind(l);l.send=e=>{We&&typeof e==`string`&&e.length>=512?(Ke++,Ge=Ge.then(async()=>{try{Xe(await qe(e))}catch{Xe(e)}finally{Ke--}})):typeof e==`string`&&Ke>0?Ge=Ge.then(()=>Xe(e)):Xe(e)};let it=a=>{if(a.data instanceof ArrayBuffer){let e=a.data,t=new DataView(e);if(e.byteLength<1)return;vr.noteBytes(e.byteLength);let s=t.getUint8(0);if((s===3||s===4)&&(window.videoChunksReceived++,Ee=performance.now(),rt!==null&&Ba()),G&&(s===3||s===4)&&(gt=performance.now(),_t=0,yt=0),s===1){if(N!==`primary`||e.byteLength<2)return;if(E||G){if(o){m&&m.state!==`running`&&m.resume().catch(e=>console.error(`Error resuming audio context`,e));let t=En(e);for(let e of t)if(e.byteLength!==0){if(!G&&window.currentAudioBufferSize>=5){window.currentAudioDropped++;break}o.postMessage({type:`decode`,data:{opusBuffer:e,timestamp:performance.now()*1e3}},[e])}}else console.warn(`AudioDecoderWorker not ready. Attempting to initialize audio pipeline.`),De().then(()=>{if(o){let t=En(e);for(let e of t)if(e.byteLength!==0){if(!G&&window.currentAudioBufferSize>=5){window.currentAudioDropped++;break}o.postMessage({type:`decode`,data:{opusBuffer:e,timestamp:performance.now()*1e3}},[e])}}})}}else if(s===3){if(e.byteLength<6)return;Wi===`jpeg`&&(Wi=null);let n=t.getUint16(2,!1);Oa.note(n),G||(O=n,Ce=performance.now());let r=t.getUint16(4,!1),i=e.slice(6);if(!G&&T&&V===`jpeg`||G&&V===`jpeg`){if(i.byteLength===0)return;C(r,i,n)}}else if(s===4){if(e.byteLength<12)return;let a=t.getUint8(1),o=t.getUint16(2,!1);Oa.note(o),G||(O=o,Ce=performance.now(),V!==`h264enc-striped`&&Er.add(O));let s=t.getUint16(4,!1),c=t.getUint16(6,!1),l=t.getUint16(8,!1),u=t.getUint16(10,!1),d=e.slice(12);if(G&&V!==`h264enc-striped`&&c>0&&l>0&&(R!==c||z!==l)&&(R=c,z=l,console.log(`Shared mode: stream is ${R}x${z} (physical).`),ua(R,z,!0)),G&&typeof VideoDecoder>`u`){mt||(mt=!0,console.error(`Shared viewing needs WebCodecs VideoDecoder, which this browser lacks.`),q&&(q.textContent=`This browser cannot decode the shared stream (no WebCodecs).`,q.classList.remove(`hidden`)));return}let f=r(a);if(Wi){if(n(a)!==i(Wi))return;Wi=null}if(ni&&H(V)&&(G||T)){if(d.byteLength===0)return;if(f){let e=Li(a,d,c,l);e!==oi&&(oi=e)}if(Fi(f,d,c,l,oi||Li(a,null,c,l),o,u))return}if(Ot(V)&&(G||T)){if(d.byteLength===0)return;let e=Tt[s],t=f?`key`:`delta`,r=!e||!e.hasReceivedKeyframe;if(t===`delta`&&r){No();return}let i=e&&e.framed&&f&&!ie(ne(new Uint8Array(d)),e.description);if(!e||e.decoder.state===`closed`||i||e.decoder.state===`configured`&&(e.width!==c||e.height!==l)){if(e&&e.decoder.state!==`closed`)try{e.decoder.close()}catch(e){console.warn(`Error closing old VNC stripe decoder:`,e)}let t=new VideoDecoder({output:Ka.bind(null,s),error:e=>va(e,s)}),r=Li(a,d,c,l),i=le()===`avcc`&&r.startsWith(`avc1`),o=i?ne(new Uint8Array(d)):null,u=Jn({codec:r,codedWidth:c,codedHeight:l,optimizeForLatency:!0,colorSpace:te(r,Gn),...o?{description:o}:{}});K.config=u,Tt[s]={decoder:t,pendingChunks:[],width:c,height:l,framed:i,description:o,hasReceivedKeyframe:!1},e=Tt[s],VideoDecoder.isConfigSupported(u).then(e=>{if(e.supported)return t.configure(u);{na(r,n(a));let e=Error(`config not supported: ${r}`);return e.quiet=!0,Promise.reject(e)}}).then(()=>{ba(s)}).catch(e=>{if(e.quiet||console.error(`Error configuring VNC stripe decoder Y=${s}:`,e),Tt[s]&&Tt[s].decoder===t){try{t.state!==`closed`&&t.close()}catch{}delete Tt[s]}})}if(e){if(t===`delta`&&!e.hasReceivedKeyframe){No();return}if(t===`key`)e.hasReceivedKeyframe=!0;else if(e.decoder.decodeQueueSize>8){e.hasReceivedKeyframe=!1,No();return}let n=V===`h264enc-striped`?o:performance.now()*1e3,r={type:t,timestamp:n,data:e.framed?re(new Uint8Array(d)):d};if(e.decoder.state===`configured`){let t=new EncodedVideoChunk(r);vr.open&&H(V)&&K.starts.set(n,performance.now());try{e.decoder.decode(t)}catch(e){Fo(e,`stripe_decode_Y=${s}`)}}else if(e.decoder.state===`unconfigured`||e.decoder.state===`configuring`){if(e.width&&(e.width!==c||e.height!==l)){console.warn(`Dropping stale stripe chunk for Y=${s}: ${c}x${l} vs decoder ${e.width}x${e.height}.`);return}e.pendingChunks.push(r)}else console.warn(`VNC stripe decoder for Y=${s} in unexpected state: ${e.decoder.state}. Dropping chunk.`)}}}else console.warn(`Unknown binary data payload type received:`,s)}else if(typeof a.data==`string`){if(a.data.startsWith(`KILL `)){let e=a.data.substring(5);console.error(`Received KILL message from server: ${e}`),tt&&clearInterval(tt),l&&(l.onclose=()=>{},l.close()),q&&(q.textContent=`Connection Terminated: ${e}`,q.classList.remove(`hidden`));return}if(a.data.startsWith(`AUTH_SUCCESS,`)){let e;try{let t=a.data.substring(13);e=JSON.parse(t)}catch(e){console.error(`Failed to parse AUTH_SUCCESS message:`,e);return}d=e.role,f=e.slot,console.log(`Authentication successful. Received Role: ${d}, Slot: ${f}`),window.postMessage({type:`clientRoleUpdate`,role:d},window.location.origin),window.webrtcInput&&typeof window.webrtcInput.updateControllerSlot==`function`&&window.webrtcInput.updateControllerSlot(f),d===`viewer`&&(console.log(`Token-based client is a 'viewer'. Applying shared mode compatibility settings.`),G=!0,window.webrtcInput&&window.webrtcInput.setSharedMode(!0),An=`shared`,jn=f!==null&&f>0?f-1:void 0,(!R||R<=0||!z||z<=0)&&(R=1280,z=720),ua(R,z,!0),window.addEventListener(`resize`,()=>{G&&R&&z&&R>0&&z>0&&ua(R,z,!0)}),ha(),ke&&(console.log(`Post-init sync: Forcing shared mode state because 'MODE websockets' was handled before auth.`),Fn=`ready`,l&&l.readyState===WebSocket.OPEN&&(l.send(`STOP_VIDEO`),setTimeout(()=>{l&&l.readyState===WebSocket.OPEN&&(document.hidden?(In=!0,console.log(`Shared mode: hidden on init, leaving video paused.`)):(l.send(`START_VIDEO`),console.log(`Shared mode: Sent START_VIDEO after initial STOP_VIDEO.`)))},250))))}if(a.data.startsWith(`MK_ACCESS,`)){let e=parseInt(a.data.split(`,`)[1])===1;console.log(`Received MK_ACCESS update: ${e}`),window.webrtcInput&&(e?window.webrtcInput.isInputAttached()||(console.log(`MK Access Granted: Attaching input context.`),window.webrtcInput.attach_context()):(console.log(`MK Access Revoked: Detaching input context.`),window.webrtcInput.detach_context()))}if(a.data.startsWith(`ROLE_UPDATE,`)){let e;try{let t=a.data.substring(12);e=JSON.parse(t)}catch(e){console.error(`Failed to parse ROLE_UPDATE message:`,e);return}console.log(`Received role update. New role: ${e.role}, New slot: ${e.slot}`);let t=f;d=e.role,f=e.slot,window.webrtcInput&&typeof window.webrtcInput.updateControllerSlot==`function`&&window.webrtcInput.updateControllerSlot(f),t!==null&&f===null?window.webrtcInput&&window.webrtcInput.gamepadManager&&(console.log(`Controller slot revoked, disabling gamepad polling.`),window.webrtcInput.gamepadManager.disable()):t===null&&f!==null&&(window.webrtcInput&&window.webrtcInput.gamepadManager&&Se?(console.log(`Controller slot granted and global gamepad toggle is ON. Enabling gamepad polling.`),window.webrtcInput.gamepadManager.enable()):window.webrtcInput&&window.webrtcInput.gamepadManager&&console.log(`Controller slot granted, but global gamepad toggle is OFF. Polling remains disabled.`))}if(a.data===`MODE websockets`){if(u=`websockets`,console.log(`[websockets] Switched to websockets mode.`),fr=`initializing`,pr=`Initializing WebSocket mode...`,Gr(),!p){let e=window.location.hash;e===`#shared`?(d=`viewer`,f=null):e.startsWith(`#player`)?(d=`viewer`,f=parseInt(e.substring(7),10)||null,f!==null&&(jn=f-1)):(d=`controller`,f=1,jn=0),console.log(`Legacy mode detected. Role from hash: ${d}, Slot: ${f}`),ro()}_a(),yo(),bo(),G||(Eo(),ko(),p||ro()),De().then(()=>{Oe()}),p&&ro(),window.webrtcInput&&typeof window.webrtcInput.setTrackpadMode==`function`&&window.webrtcInput.setTrackpadMode(Rt),Rt&&l&&l.readyState===WebSocket.OPEN&&(l.send(`SET_NATIVE_CURSOR_RENDERING,1`),console.log(`[websockets] Applied trackpad mode on initialization.`)),kr&&kr.classList.add(`hidden`),q&&q.classList.remove(`hidden`),w(),G?(Fn=`ready`,console.log(`Shared mode: Received 'MODE websockets'. Requesting initial stream with STOP/START_VIDEO. State: ready.`),Ga(),l&&l.readyState===WebSocket.OPEN&&(l.send(`STOP_VIDEO`),setTimeout(()=>{l&&l.readyState===WebSocket.OPEN&&(document.hidden?(In=!0,console.log(`Shared mode: hidden on init, leaving video paused.`)):(l.send(`START_VIDEO`),console.log(`Shared mode: Sent START_VIDEO after initial STOP_VIDEO.`)))},250))):l&&l.readyState===WebSocket.OPEN&&E&&(j?l.send(`START_AUDIO`):je=!0),pr=`Waiting for stream...`,Gr(),ke=!0,vr.subscribe(),Sr!==null&&clearInterval(Sr);let e=0;Sr=setInterval(()=>{if(xr||!T||Gi||!l||l.readyState!==WebSocket.OPEN||e>=5){clearInterval(Sr),Sr=null;return}e++,console.log(`No frame since connect; requesting keyframe (attempt ${e}).`),No()},3e3)}else if(u===`websockets`){if(a.data.startsWith(`{`)){let e;try{e=JSON.parse(a.data)}catch(e){console.error(`Error parsing JSON:`,e);return}if(e.type===`stream_info`)vr.setInfo(e.info),Kn(e.info);else if(e.type===`stream_stats`)vr.serverSample(e.stats);else if(e.type===`server_settings`){if(N!==`primary`&&e.settings.second_screen&&e.settings.second_screen.value===!1){console.error(`The server reports no second display is available. This client will not function.`),q&&(q.textContent=`Error: A second display is not available on this server.`,q.classList.remove(`hidden`)),l&&(l.onclose=()=>{},l.close()),tt&&=(clearInterval(tt),null);return}let t=Br(e.settings);if(typeof window.encoder==`string`&&window.encoder!==V){let e=window.encoder;console.log(`Server settings switch encoder ${V} -> ${e}.`),V=e,wi(),e!==`h264enc-striped`&&_a(),yo(),bo()}Number.isFinite(parseInt(window.framerate,10))&&($n=parseInt(window.framerate,10)),typeof window.video_fullcolor==`boolean`&&(tr=window.video_fullcolor);let n=e.settings&&e.settings.video_fullcolor;Vi=!!(n&&n.locked),tr&&Hi(`full color the server announced is not decoded here`),typeof window.video_streaming_mode==`boolean`&&(nr=window.video_streaming_mode);let r=e.settings&&e.settings.command_enabled;Ln=r&&typeof r.value==`boolean`?r.value:!0,j||(j=!0,oo(e.settings)),je&&(je=!1,E&&l&&l.readyState===WebSocket.OPEN&&l.send(`START_AUDIO`));let i=e.settings&&e.settings.enable_resize;i&&typeof i.value==`boolean`&&(window.enable_resize=i.value);let a=e.settings&&e.settings.clipboard_in_enabled;a&&typeof a.value==`boolean`&&(Yt=a.value);let o=e.settings&&e.settings.clipboard_out_enabled;o&&typeof o.value==`boolean`&&(W=o.value);let s=e.settings&&e.settings.enable_binary_clipboard;s&&typeof s.value==`boolean`&&(hn=s.locked?s.value:X(`enable_binary_clipboard`,s.value));let c=e.settings&&e.settings.webcam_encoder;if(c&&qt.includes(c.value)){let e=Fr(`webcam_encoder`,c.value);Ie=c.locked||!qt.includes(e)?c.value:e}let u=Lr(e.settings);u!==kt&&window.postMessage({type:`setUseCssScaling`,value:u},window.location.origin);let d=Rr(e.settings);d!==$t&&($t=d,en());let f=zr(e.settings);f!==tn&&(tn=f,nn()),y(),window.postMessage({type:`serverSettings`,payload:e.settings},window.location.origin),Object.keys(t).length>0&&(console.log(`Client settings were sanitized by server rules. Sending updates back to server:`,t),po(t,!0)),e.settings.encoder_backends&&(Yi=e.settings.encoder_backends.value||null),typeof window.encoder==`string`&&ia(window.encoder,e.settings.encoder);let p=e.settings&&e.settings.manual_resolution&&e.settings.manual_resolution.value===!0;if(p||window.manual_resolution){if(console.log(`Manual resolution mode active (Server forced: ${p}, Client pref: ${window.manual_resolution}). Switching to manual resize handlers.`),p){let t=e.settings.manual_width?parseInt(e.settings.manual_width.value,10):0,n=e.settings.manual_height?parseInt(e.settings.manual_height.value,10):0;t>0&&n>0?(console.log(`Applying server-enforced manual resolution: ${t}x${n}`),window.manual_resolution=!0,R=t,z=n,ua(R,z,wr),U(`server resolution`)&&aa(`server resolution`)):console.warn(`Server dictated manual mode but did not provide valid dimensions.`)}else R&&z&&ua(R,z,wr);ma()}else console.log(`Server settings payload confirms auto mode. Switching to auto resize handlers.`),fa()}else if(e.type===`server_apps`)e.apps&&Array.isArray(e.apps)&&window.postMessage({type:`systemApps`,apps:e.apps},window.location.origin);else if(e.type===`print_document`)window.location.hash.startsWith(`#display2`)||Vr.announce(e.name,e.size_bytes);else if(e.type===`pipeline_status`){let t=!1;e.video!==void 0&&e.video!==T&&(T=e.video,t=!0,!T&&Ot(V)&&!G&&_a()),e.audio!==void 0&&e.audio!==E&&(E=e.audio,t=!0,o&&o.postMessage({type:`updatePipelineStatus`,data:{isActive:E}}),l&&l.setAudioActive&&l.setAudioActive(E)),t&&window.postMessage({type:`pipelineStatusUpdate`,video:T,audio:E},window.location.origin)}else if(e.type===`stream_resolution`){let t=e.displayId||`primary`;if(t!==N)console.log(`Ignoring stream_resolution for display '${t}' (this page renders '${N}').`);else if(G){if(Fn===`error`||Fn===`idle`)console.log(`Shared mode: Received stream_resolution while in state '${Fn}'. Ignoring.`);else{let t=parseInt(e.width,10),n=parseInt(e.height,10);if(t>0&&n>0){let e=Z(t),r=Z(n),i=R!==e||z!==r;i&&(console.log(`Shared mode: Received new stream resolution ${e}x${r} (physical).`),R=e,z=r,ua(R,z,!0)),Fn===`ready`&&i&&(console.log(`Shared mode: Clearing decoders and canvas for new resolution.`),_a(),c&&s.width>0&&s.height>0&&(c.setTransform(1,0,0,1,0,0),c.clearRect(0,0,s.width,s.height)))}else console.warn(`Shared mode: Received invalid stream_resolution dimensions: ${e.width}x${e.height}`)}}else{let t=parseInt(e.width,10),n=parseInt(e.height,10);if(t>0&&n>0){let e=window.manual_resolution?1:Nt(),r=Z(t),i=Z(n),a=!window.manual_resolution&&It&&r===It[0]&&i===It[1];s&&r>0&&i>0&&(s.width!==r||s.height!==i)&&(_a(),a?(window.streamResolutionDiverged=!1,da(It[2],It[3])):(console.log(`Server realized stream resolution ${t}x${n} (canvas buffer ${s.width}x${s.height}); reconciling.`),window.streamResolutionDiverged=!0,window.manual_resolution?(R=r,z=i,ua(R,z,wr)):ua((r+.5)/e,(i+.5)/e,!0)))}else console.warn(`Received invalid stream_resolution dimensions: ${e.width}x${e.height}`)}}else console.warn(`Unexpected JSON message type:`,e.type,e)}else if(a.data.startsWith(`cursor,`))try{let e=JSON.parse(a.data.substring(7));window.webrtcInput&&typeof window.webrtcInput.updateServerCursor==`function`&&window.webrtcInput.updateServerCursor(e)}catch(e){console.error(`Error parsing cursor data:`,e)}else if(a.data.startsWith(`clipboard_reply,`))a.data.substring(16)===`cr`&&Tn();else if(a.data.startsWith(`clipboard_start,`)){let e=a.data.split(`,`);yn.begin(e[1],parseInt(e[2],10)),console.log(`Starting multi-part clipboard download: ${yn.mimeType}, total size: ${yn.totalSize}`)}else if(a.data.startsWith(`clipboard_data,`)){if(yn.inProgress)try{yn.push(a.data.substring(15))}catch(e){console.error(`Error processing multi-part clipboard chunk:`,e),yn.reset()}}else if(a.data===`clipboard_finish`){if(yn.inProgress){if(console.log(`Finished multi-part clipboard download. Received ${yn.receivedSize} of ${yn.totalSize} bytes.`),yn.receivedSize!==yn.totalSize)console.error(`Multipart clipboard size mismatch. Aborting.`),yn.reset();else{let e=Dn(),t=yn.mimeType;yn.finish().then(({result:n,hash:r,byteLength:i})=>{if(t===`text/plain`){let t=n,r=_n.shouldSend(t,`text/plain`);_n.resolveServer(t,null,`text/plain`),!e&&W&&r&&vn.write(()=>navigator.clipboard.writeText(t),{onFailure:e=>console.error(`Could not copy server clipboard text to local: `+e)}),window.postMessage(ut(t),window.location.origin)}else if(W&&hn){let a=new Blob([n],{type:t}),o=Je(i,r),s=_n.shouldSend(o,t);_n.resolveServer(void 0,a,t,o),!e&&s&&vn.write(()=>Ze(a,t,mn),{onSuccess:()=>{console.log(`Successfully wrote multi-part image (${t}) from server to local clipboard.`),_n.captureLocalImageSig();let e=`Image (${t}) received from session and copied to clipboard.`;window.postMessage({type:`clipboardContentUpdate`,text:e},window.location.origin)},onFailure:uo})}}).catch(e=>{console.error(`Error assembling final clipboard content:`,e)})}}}else if(a.data.startsWith(`clipboard_binary,`)){let e=a.data.split(`,`);if(e.length<3){console.error(`Malformed binary clipboard message from server:`,a.data);return}let t=e[1],n=t===Qe;if(!n&&!hn){console.warn(`Received binary clipboard data from server, but feature is disabled on client. Ignoring.`);return}if(!W){console.warn(`Received server clipboard image while server->client sync is disabled. Ignoring.`);return}try{let r=e[2],i=Dn();pn.decode(r,t).then(({result:e,hash:r,byteLength:a})=>{let o=e;if(n){let e=et(o),n=Je(a,r),s=_n.shouldSend(n,t);if(_n.resolveServer(e.text||e.html,null,t,n),window.postMessage(ut(e.text||e.html),window.location.origin),i||!s||!Xt)return;vn.write(()=>nt(e),{onFailure:e=>console.error(`Could not copy session markup to local: `+e)});return}let s=new Blob([o],{type:t}),c=Je(a,r),l=_n.shouldSend(c,t);_n.resolveServer(void 0,s,t,c),!i&&l&&Xt&&vn.write(()=>Ze(s,t,mn),{onSuccess:()=>{console.log(`Successfully wrote image (${t}) from server to local clipboard.`),_n.captureLocalImageSig();let e=`Image (${t}) received from session and copied to clipboard.`;window.postMessage({type:`clipboardContentUpdate`,text:e},window.location.origin)},onFailure:uo})}).catch(e=>{console.error(`Error processing binary clipboard data from server:`,e)})}catch(e){console.error(`Error processing binary clipboard data from server:`,e)}}else if(a.data.startsWith(`clipboard,`))try{let e=a.data.substring(10),t=!Dn()&&W&&Xt;pn.decode(e,`text/plain`).then(({result:e})=>{let n=e,r=_n.shouldSend(n,`text/plain`);_n.resolveServer(n,null,`text/plain`),t&&r&&vn.write(()=>navigator.clipboard.writeText(n),{onFailure:e=>console.error(`Could not copy server clipboard to local: `+e)}),window.postMessage(ut(n),window.location.origin)}).catch(e=>{console.error(`Error processing clipboard data:`,e)})}catch(e){console.error(`Error processing clipboard data:`,e)}else if(a.data.startsWith(`system,`))try{let e=JSON.parse(a.data.substring(7));e.action===`reload`?window.location.reload():typeof e.action==`string`&&e.action.startsWith(`command_error,`)&&!G?window.postMessage({type:`fileUpload`,payload:{status:`warning`,fileName:`command`,message:e.action.slice(14),code:`commandFailed`}},window.location.origin):typeof e.action==`string`&&e.action.startsWith(`command_done,`)&&!G?window.postMessage({type:`commandDone`,command:e.action.slice(13)},window.location.origin):typeof e.action==`string`&&e.action.startsWith(`apps_installed,`)&&!G&&window.postMessage({type:`appsInstalled`,apps:JSON.parse(e.action.slice(15))},window.location.origin)}catch(e){console.error(`Error parsing system data:`,e)}else if(a.data===`VIDEO_STARTED`&&!G)Ba(),T=!0,window.postMessage({type:`pipelineStatusUpdate`,video:!0},window.location.origin);else if(a.data===`VIDEO_STOPPED`&&!G)console.log(`Client: Received VIDEO_STOPPED. Updating isVideoPipelineActive=false. Expecting PIPELINE_RESETTING from server for full state reset.`),T=!1,window.postMessage({type:`pipelineStatusUpdate`,video:!1},window.location.origin);else if(a.data.startsWith(`PIPELINE_RESETTING `)){let e=a.data.split(` `),t=e.length>1?e[1]:`primary`;console.log(`[websockets] Received PIPELINE_RESETTING for display '${t}'.`),G&&t===`primary`||!G&&t===N?(jo(`PIPELINE_RESETTING from server for display '${t}'`),G?(console.log(`Shared mode: Primary pipeline reset. Client remains in ready state.`),Fn=`ready`):console.log(`Display '${N}': Video reset complete.`)):console.log(`Ignoring PIPELINE_RESETTING for '${t}' as this client is '${G?`shared`:N}'.`)}else if(a.data.startsWith(`DISPLAY_CONFIG_UPDATE,`))try{let n=a.data.substring(a.data.indexOf(`,`)+1),r=JSON.parse(n);if(t=r.layouts||null,At=!!r.wayland,window.webrtcInput&&window.webrtcInput.setDisplayLayouts&&window.webrtcInput.setDisplayLayouts(t,N),Lt(),N===`primary`){let t=r.displays.includes(`display2`);e!==t&&(console.log(`Secondary display connection status changed to: ${t}`),e=t,Qt())}}catch(e){console.error(`Error parsing DISPLAY_CONFIG_UPDATE:`,e,`Original data:`,a.data)}else if(a.data===`AUDIO_STARTED`&&!G)E=!0,window.postMessage({type:`pipelineStatusUpdate`,audio:!0},window.location.origin),o&&o.postMessage({type:`updatePipelineStatus`,data:{isActive:!0}}),l&&l.setAudioActive&&l.setAudioActive(!0);else if(a.data===`AUDIO_STOPPED`&&!G)E=!1,window.postMessage({type:`pipelineStatusUpdate`,audio:!1},window.location.origin),o&&o.postMessage({type:`updatePipelineStatus`,data:{isActive:!1}}),l&&l.setAudioActive&&l.setAudioActive(!1);else if(a.data===`AUDIO_DISABLED`&&!G){if(console.log(`Server reports audio is disabled. Tearing down audio workers.`),A=!1,E=!1,o&&(o.postMessage({type:`updatePipelineStatus`,data:{isActive:!1}}),l&&l.setAudioActive&&l.setAudioActive(!1),o.postMessage({type:`close`}),setTimeout(()=>{o&&=(o.terminate(),null)},50)),m){try{m.close()}catch(e){console.error(`Error closing AudioContext on AUDIO_DISABLED:`,e)}m=null,h=null,v=null}window.postMessage({type:`pipelineStatusUpdate`,audio:!1},window.location.origin)}else if(a.data===`MICROPHONE_DISABLED`&&!G)console.log(`Server reports microphone is disabled. Stopping microphone capture.`),Me=!1,Eo(),window.postMessage({type:`pipelineStatusUpdate`,microphone:!1},window.location.origin);else if(a.data===`WEBCAM_DISABLED`&&!G)console.log(`Server reports webcam is disabled. Stopping webcam capture.`),Ne=!1,ko(),window.postMessage({type:`pipelineStatusUpdate`,webcam:!1},window.location.origin);else if(a.data===`WEBCAM_KEYFRAME`)M&&M.requestKeyframe();else if(a.data.startsWith(`CAPTURE_DEMAND `)&&!G){let[e,t]=a.data.slice(15).split(` `);e===`webcam`&&Ne&&!Ae.has(`webcam`)?t===`1`?Fe||Oo(!0):ko():e===`microphone`&&Me&&!Ae.has(`microphone`)&&(t===`1`?Pe||To(!0):Eo())}else window.webrtcInput&&window.webrtcInput.on_message&&!G&&window.webrtcInput.on_message(a.data)}}};l.onmessage=e=>{let t=e.data;if(t instanceof ArrayBuffer){if(t.byteLength>=1&&new Uint8Array(t,0,1)[0]===5){Ue++;let e=t.slice(1);He=He.then(async()=>{try{it({data:await L(e)})}catch(e){console.error(`[websockets] gzip control inflate failed:`,e)}finally{Ue--}});return}it(e);return}if(t===`_gz,1`){typeof CompressionStream<`u`&&(We=!0);return}Ue>0?He=He.then(()=>it({data:t})):it({data:t})},l.onerror=e=>{console.error(`[websockets] Error:`,e),fr=`error`,pr=`WebSocket connection error.`,Gr(),Ye&&=(clearInterval(Ye),null),$e&&=(clearInterval($e),null),$a(),G&&(console.error(`Shared mode: WebSocket error. Resetting shared state to 'error'.`),Fn=`error`)},l.onclose=e=>{if(console.log(`[websockets] Connection closed`,e),vr.disconnected(),window.__selkiesAuthProbe&&window.__selkiesAuthProbe(),e.code===4001){console.error(`Server rejected connection: Invalid token. Disabling reconnect.`),tt&&clearInterval(tt),tt=null,pr=`Connection Failed: Invalid Token`,Gr();return}e.code===4002&&console.log(`Server closed connection due to permission change. Reconnecting...`);let t=/superseded/i.test(e.reason||``);t&&(console.warn(`Session superseded by a new connection. Auto-reconnect disabled.`),tt&&clearInterval(tt),tt=null),fr=`disconnected`,pr=t?`Session opened elsewhere. Reload this page to take over.`:`WebSocket disconnected. Attempting to reconnect...`,Gr(),Ye&&=(clearInterval(Ye),null),$e&&=(clearInterval($e),null),$a(),yo(),_a(),Pa(),o&&=(o.postMessage({type:`close`}),null),G||(Eo(),ko()),T=!1,E=!1,D=!1,window.postMessage({type:`pipelineStatusUpdate`,video:!1,audio:!1},window.location.origin),G&&(console.log(`Shared mode: WebSocket closed. Resetting shared state to 'idle'.`),Fn=`idle`,Wa()),!t&&!tt&&(tt=setInterval(()=>{l&&(l.readyState===WebSocket.OPEN||l.readyState===WebSocket.CONNECTING)||(console.log(`WebSocket disconnected, reloading page to reconnect.`),vo())},5e3))}}let _o=!1;async function vo(){let e=null;try{e=sessionStorage.getItem(`selkies_mode_flip`)}catch{}if(!_o&&!e)try{let e=new URL(window.location.href);if(e.pathname=he()+`/api/websockets`,(await fetch(e.href,{cache:`no-store`,headers:ht()})).status===409){try{sessionStorage.setItem(`selkies_mode_flip`,`1`)}catch{}zn(`${Rn}_stream_mode`,`webrtc`),console.warn(`[websockets] Server is serving WebRTC (endpoint 409); switching stored mode.`)}}catch{}location.reload()}document.readyState===`loading`?document.addEventListener(`DOMContentLoaded`,go):go();function yo(){let e=0;for(;ve.length>0;){let t=ve.shift();if(t&&t.image&&typeof t.image.close==`function`)try{t.image.close(),e++}catch{}}e>0&&console.log(`Cleanup: Closed ${e} JPEG stripe images.`),za={},wa=null,Ta=!1}function bo(){for(;xa.length>0;){let e=xa.shift();try{e&&e.frame&&e.frame.close()}catch{}}wa=null,Ta=!1}let xo={6:{streams:4,coupled:2,mapping:[0,4,1,2,3,5]},8:{streams:5,coupled:3,mapping:[0,6,1,2,3,4,5,7]}};function So(){let e=parseInt(window.audio_channels,10);return e===1||e===2||e===6||e===8?e:2}function Co(e){let t=xo[e];if(!t)return null;let n=new ArrayBuffer(21+e),r=new Uint8Array(n),i=new DataView(n);return r.set([79,112,117,115,72,101,97,100]),r[8]=1,r[9]=e,i.setUint16(10,0,!0),i.setUint32(12,48e3,!0),i.setInt16(16,0,!0),r[18]=1,r[19]=t.streams,r[20]=t.coupled,r.set(t.mapping,21),n}let wo=`
  let decoderAudio;
  let pipelineActive = true;
  let currentDecodeQueueSize = 0;
  // Set once the page hands over the worklet's line; until then decoded packets
  // go back through the page, which is also the path a worklet-less build takes.
  let pcmPort = null;
  let audioIn = null;
  let lastAudioTs = null;

  function audioTsNewer(a, b) {
    const d = (a - b) >>> 0;
    return d !== 0 && d < 0x80000000;
  }

  function extractOpusFrames(arrayBuffer) {
    const bytes = new Uint8Array(arrayBuffer);
    const nRed = bytes[1];
    if (!nRed) { lastAudioTs = null; return [arrayBuffer.slice(2)]; }
    // With n_red > 0 the bytes after the flag word are headers, not Opus, so a
    // truncated fixed part leaves no primary to salvage.
    if (arrayBuffer.byteLength < 6 + nRed * 4 + 1) { lastAudioTs = null; return []; }
    const pts = ((bytes[2] << 24) | (bytes[3] << 16) | (bytes[4] << 8) | bytes[5]) >>> 0;
    let pos = 6;
    const offsets = [], lens = [];
    for (let i = 0; i < nRed; i++) {
      const field = (bytes[pos + 1] << 16) | (bytes[pos + 2] << 8) | bytes[pos + 3];
      offsets.push((field >> 10) & 0x3fff);
      lens.push(field & 0x3ff);
      pos += 4;
    }
    pos += 1;
    // The declared block lengths must fit the payload: slice() clamps silently,
    // and the primary cannot be located without trustworthy lengths.
    let declared = pos;
    for (let i = 0; i < nRed; i++) { declared += lens[i]; }
    if (declared > arrayBuffer.byteLength) { lastAudioTs = null; return []; }
    const blocks = [];
    for (let i = 0; i < nRed; i++) {
      blocks.push({ ts: (pts - offsets[i]) >>> 0, buf: arrayBuffer.slice(pos, pos + lens[i]) });
      pos += lens[i];
    }
    blocks.push({ ts: pts, buf: arrayBuffer.slice(pos) });
    if (lastAudioTs === null) {
      lastAudioTs = pts;
      return [blocks[blocks.length - 1].buf];
    }
    const out = [];
    let last = lastAudioTs;
    for (const b of blocks) {
      if (audioTsNewer(b.ts, last)) { out.push(b.buf); last = b.ts; }
    }
    lastAudioTs = last;
    return out;
  }
  const decoderConfig = {
    codec: 'opus',
    numberOfChannels: 2,
    sampleRate: 48000,
  };

  async function initializeDecoderInWorker() {
    if (decoderAudio && decoderAudio.state !== 'closed') {
      try { decoderAudio.close(); } catch (e) { /* ignore */ }
    }
    currentDecodeQueueSize = 0;
    decoderAudio = new AudioDecoder({
      output: handleDecodedAudioFrameInWorker,
      error: (e) => {
        // A fatal decoder error is not re-initialized from here: a persistent
        // failure would spin. The page drives recovery with its 'reinitialize'
        // message, which also re-checks the codec configuration.
        console.error('[AudioWorker] AudioDecoder error:', e.message, e);
        currentDecodeQueueSize = Math.max(0, currentDecodeQueueSize -1);
      },
    });
    try {
      const support = await AudioDecoder.isConfigSupported(decoderConfig);
      if (support.supported) {
        await decoderAudio.configure(decoderConfig);
        self.postMessage({ type: 'decoderInitialized' });
      } else {
        decoderAudio = null;
        self.postMessage({ type: 'decoderInitFailed', reason: 'configNotSupported' });
      }
    } catch (e) {
      decoderAudio = null;
      self.postMessage({ type: 'decoderInitFailed', reason: e.message });
    }
  }

  async function handleDecodedAudioFrameInWorker(frame) {
    currentDecodeQueueSize = Math.max(0, currentDecodeQueueSize - 1);
    if (!frame || typeof frame.copyTo !== 'function' || typeof frame.allocationSize !== 'function' || typeof frame.close !== 'function') {
        if(frame && typeof frame.close === 'function') { try { frame.close(); } catch(e) { /* ignore */ } }
        return;
    }
    let pcmDataArrayBuffer;
    try {
      const requiredByteLength = frame.allocationSize({ planeIndex: 0, format: 'f32' });
      if (requiredByteLength === 0) {
          try { frame.close(); } catch(e) { /* ignore */ }
          return;
      }
      pcmDataArrayBuffer = new ArrayBuffer(requiredByteLength);
      const pcmDataView = new Float32Array(pcmDataArrayBuffer);
      await frame.copyTo(pcmDataView, { planeIndex: 0, format: 'f32' });
      if (pcmPort) pcmPort.postMessage({ audioData: pcmDataArrayBuffer }, [pcmDataArrayBuffer]);
      else self.postMessage({ type: 'decodedAudioData', pcmBuffer: pcmDataArrayBuffer }, [pcmDataArrayBuffer]);
      pcmDataArrayBuffer = null;
    } catch (error) { /* console.error */ }
    finally {
      if (frame && typeof frame.close === 'function') {
        try { frame.close(); } catch (e) { /* ignore */ }
      }
    }
  }

  self.onmessage = async (event) => {
    const { type, data } = event.data;
    switch (type) {
      case 'init':
        pipelineActive = data.initialPipelineStatus;
        if (data.channels) {
          decoderConfig.numberOfChannels = data.channels;
        }
        if (data.description) {
          decoderConfig.description = data.description;
        }
        await initializeDecoderInWorker();
        break;
      case 'decode':
        if (decoderAudio && decoderAudio.state === 'configured') {
          const chunk = new EncodedAudioChunk({ type: 'key', timestamp: data.timestamp || (performance.now() * 1000), data: data.opusBuffer });
          try {
            if (currentDecodeQueueSize < 20) {
                 decoderAudio.decode(chunk); currentDecodeQueueSize++;
            }
          } catch (e) {
              currentDecodeQueueSize = Math.max(0, currentDecodeQueueSize - 1);
              if (decoderAudio.state === 'closed' || decoderAudio.state === 'unconfigured') await initializeDecoderInWorker();
          }
        } else if (!decoderAudio || (decoderAudio && decoderAudio.state !== 'configuring')) {
          await initializeDecoderInWorker();
        }
        break;
      case 'reinitialize': await initializeDecoderInWorker(); break;
      case 'pcmPort': pcmPort = event.data.port; break;
      case 'audioIn':
        audioIn = event.data.port;
        audioIn.onmessage = (m) => {
          if (!decoderAudio || decoderAudio.state !== 'configured') return;
          for (const opus of extractOpusFrames(m.data.buffer)) {
            if (!opus.byteLength) continue;
            try {
              decoderAudio.decode(new EncodedAudioChunk({
                type: 'key', timestamp: performance.now() * 1000, data: opus }));
            } catch (err) { /* a reconfiguring decoder drops the packet */ }
          }
        };
        break;
      case 'updatePipelineStatus': pipelineActive = data.isActive; break;
      case 'close':
        if (decoderAudio && decoderAudio.state !== 'closed') { try { decoderAudio.close(); } catch (e) { /* ignore */ } }
        decoderAudio = null; self.close(); break;
      default: break;
    }
  };
`;async function To(e=!1){if(G){console.log(`Shared mode: Microphone capture blocked.`),D=!1,so();return}if(D||!navigator.mediaDevices||!navigator.mediaDevices.getUserMedia){D||=!1,so();return}let t;try{t={audio:{deviceId:L?{exact:L}:void 0,sampleRate:24e3,channelCount:1,echoCancellation:!0,noiseSuppression:!0,autoGainControl:!0},video:!1},F=await navigator.mediaDevices.getUserMedia(t);let e=F.getAudioTracks();if(e.length>0){let t=e[0].getSettings();!L&&t.deviceId&&(L=t.deviceId)}I&&I.state!==`closed`&&await I.close(),I=new AudioContext({sampleRate:24e3}),I.state===`suspended`&&await I.resume();let n=new Blob([`
class MicWorkletProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.SILENCE_THRESHOLD_CHUNKS = 300;
    this.silentChunkCounter = 0;
    this.isSending = true;
    // The encode worker's own line in: capture then reaches it whatever the
    // page's thread is doing. Until it is handed over, the page relays.
    this.out = this.port;
    this.port.onmessage = (e) => {
      if (e.data && e.data.port) this.out = e.data.port;
    };
  }
  process(inputs, outputs, parameters) {
    const input = inputs[0];
    if (input && input[0]) {
      const inputChannelData = input[0];
      const int16Array = Int16Array.from(inputChannelData, x => x * 32767);
      const isCurrentChunkSilent = int16Array.every(item => item === 0);
      if (!isCurrentChunkSilent) {
        this.isSending = true;
        this.silentChunkCounter = 0;
      } else {
        this.silentChunkCounter++;
      }
      if (this.silentChunkCounter >= this.SILENCE_THRESHOLD_CHUNKS) {
        this.isSending = false;
      }
      if (this.isSending) {
        this.out.postMessage(int16Array.buffer, [int16Array.buffer]);
      }
    }
    return true;
  }
}
registerProcessor('mic-worklet-processor', MicWorkletProcessor);
`],{type:`application/javascript`}),r=URL.createObjectURL(n);try{await I.audioWorklet.addModule(r)}finally{URL.revokeObjectURL(r)}ze=I.createMediaStreamSource(F),Be=new AudioWorkletNode(I,`mic-worklet-processor`);let i=URL.createObjectURL(new Blob([`
  let encoder = null, tsUs = 0, active = true, wirePort = null;
  const onPcm = (buffer) => {
    if (!active || !encoder || encoder.state !== 'configured') return;
    if (!buffer || !(buffer instanceof ArrayBuffer) || buffer.byteLength === 0) return;
    const numFrames = buffer.byteLength / 2;
    const audioData = new AudioData({ format: 's16', sampleRate: 24000, numberOfFrames: numFrames, numberOfChannels: 1, timestamp: tsUs, data: buffer });
    tsUs += Math.round(numFrames * 1e6 / 24000);
    try { encoder.encode(audioData); } catch (err) {}
    audioData.close();
  };
  self.onmessage = async (e) => {
    const m = e.data;
    if (m.type === 'pcmPort') { m.port.onmessage = (ev) => onPcm(ev.data); return; }
    if (m.type === 'wirePort') { wirePort = m.port; return; }
    if (m.type === 'init') {
      const base = { codec: 'opus', sampleRate: 24000, numberOfChannels: 1, bitrate: 32000 };
      let cfg = { ...base, opus: { application: 'lowdelay' } };
      try { const s = await AudioEncoder.isConfigSupported(cfg); if (!s || !s.supported) cfg = base; } catch (err) { cfg = base; }
      try {
        encoder = new AudioEncoder({
          output: (chunk) => {
            if (!active) return;
            const buf = new ArrayBuffer(1 + chunk.byteLength);
            new Uint8Array(buf)[0] = 0x02;
            chunk.copyTo(new Uint8Array(buf, 1));
            if (wirePort) wirePort.postMessage(buf, [buf]);
            else self.postMessage({ type: 'chunk', buffer: buf }, [buf]);
          },
          error: (err) => self.postMessage({ type: 'error', message: String(err && err.message) }),
        });
        encoder.configure(cfg);
        self.postMessage({ type: 'ready' });
      } catch (err) { self.postMessage({ type: 'error', message: String(err && err.message) }); }
      return;
    }
    if (m.type === 'pcm') { onPcm(m.buffer); return; }
    if (m.type === 'stop') { active = false; try { encoder && encoder.state !== 'closed' && encoder.close(); } catch (err) {} encoder = null; return; }
  };
`],{type:`application/javascript`}));if(Ve=new Worker(i),URL.revokeObjectURL(i),Ve.onmessage=e=>{let t=e.data;if(t.type===`chunk`){if(!(l&&l.readyState===WebSocket.OPEN&&D))return;try{l.send(t.buffer)}catch(e){console.error(`Error sending mic Opus:`,e)}}else t.type===`error`&&console.error(`Mic AudioEncoder error:`,t.message)},Ve.onerror=e=>console.error(`Mic encode worker error:`,e&&e.message),Ve.postMessage({type:`init`}),l&&l.connectSend){let e=new MessageChannel;Be.port.postMessage({port:e.port1},[e.port1]),Ve.postMessage({type:`pcmPort`,port:e.port2},[e.port2]);let t=new MessageChannel;Ve.postMessage({type:`wirePort`,port:t.port1},[t.port1]),l.connectSend(t.port2)}Be.port.onmessage=e=>{let t=e.data;if(Ve&&D&&t&&t instanceof ArrayBuffer&&t.byteLength!==0)try{Ve.postMessage({type:`pcm`,buffer:t},[t])}catch(e){console.error(`Mic PCM forward error:`,e)}},Be.port.onmessageerror=e=>console.error(`Error from mic worklet:`,e),ze.connect(Be),D=!0,so()}catch(t){console.error(`Failed to start microphone capture:`,t),e?ye(t)&&(Pe=!0):alert(`Microphone error: ${t.name} - ${t.message}`),Eo()}}function Eo(){if(!D&&!F&&!I){D&&(D=!1,so());return}if(F&&=(F.getTracks().forEach(e=>e.stop()),null),Be){Be.port.onmessage=null,Be.port.onmessageerror=null;try{Be.disconnect()}catch{}Be=null}if(Ve){try{Ve.postMessage({type:`stop`})}catch{}try{Ve.terminate()}catch{}Ve=null}if(ze){try{ze.disconnect()}catch{}ze=null}I&&(I.state===`closed`?I=null:I.close().catch(e=>console.error(`Error closing mic AudioContext:`,e)).finally(()=>I=null)),D&&(D=!1,so())}let Do=0;function Oo(e=!1){G||M||(M=new on({encoderPreference:Ie,sendFrame:(e,t,n,r,i)=>{if(!(l&&l.readyState===WebSocket.OPEN&&xe))return;let a=new ArrayBuffer(3+n.byteLength),o=new Uint8Array(a);o[0]=6,o[1]=e,o[2]=+!!t|((r||0)/90&3)<<1|(i?8:0),o.set(n,3);try{Do=a.byteLength,l.send(a)}catch(e){console.error(`Error sending webcam frame:`,e)}},canSend:()=>!l||l.bufferedAmount<=Math.max(M.bitrate/8*250/1e3,Do),onStateChange:e=>{xe=e,so()},onError:t=>{console.error(`Webcam capture error:`,t),e?ye(t)&&(Fe=!0):alert(`Webcam error: ${t.name||`Error`} - ${t.message||t}`),ko()}}),l&&l.connectWebcam&&M.setWireProvider(()=>{if(!l||!l.connectWebcam)return null;let e=new MessageChannel;return l.connectWebcam(e.port2),e.port1}),M.start(null))}function ko(){M&&=(M.stop(),null),xe&&(xe=!1,so())}function Ao(){Ye&&=(clearInterval(Ye),null),$e&&=(clearInterval($e),null),Wa(),$a(),!window.isCleaningUp&&(window.isCleaningUp=!0,console.log(`Cleanup: Starting cleanup process...`),G||(Eo(),ko()),l&&(l.onopen=null,l.onmessage=null,l.onerror=null,l.onclose=null,(l.readyState===WebSocket.OPEN||l.readyState===WebSocket.CONNECTING)&&l.close(),l=null,window.selkiesTransport=null,ci=!1),m&&(m.state!==`closed`&&m.close().catch(e=>console.error(`Cleanup error:`,e)),m=null,h=null,v=null,window.currentAudioBufferSize=0,o&&=(o.postMessage({type:`close`}),o.terminate(),null)),yo(),_a(),L=null,We=null,fr=`connecting`,pr=``,xr=!1,Cr=!1,q&&(q.textContent=`Connecting...`),q&&q.classList.remove(`hidden`),kr&&kr.classList.remove(`hidden`),J&&(J.style.cursor=`auto`),T=!0,E=!0,D=!1,Ae.clear(),j=!1,je=!1,window.fps=0,Tr=0,Or=performance.now(),console.log(`Cleanup: Finished cleanup process.`),window.isCleaningUp=!1)}function jo(e=`unknown`){if(console.log(`Performing server-initiated video reset. Reason: ${e}. Current lastReceivedVideoFrameId before reset: ${O}`),O=-1,Ea=null,we=-1,l&&typeof l.resetVideoAck==`function`&&l.resetVideoAck(),console.log(`  Reset lastReceivedVideoFrameId to ${O}.`),yo(),bo(),Ot(V)&&_a(),si&&(si=!1,ri=null,ii=0,ai=0,oi=null,wi()),c&&s&&!Ot(V))try{c.setTransform(1,0,0,1,0,0),c.clearRect(0,0,s.width,s.height),console.log(`  Cleared canvas during server-initiated reset.`)}catch(e){console.error(`  Error clearing canvas during server-initiated reset:`,e)}}let Mo=0;function No(){let e=performance.now();e-Mo<(G?1500:500)||(Mo=e,l&&l.readyState===WebSocket.OPEN&&l.send(`REQUEST_KEYFRAME`))}function Po(){if(ri=null,ii=0,ai=0,oi=null,si=!1,Q)try{Q.postMessage({type:`closeDecoder`})}catch{}_a(),Mo=0,No()}function Fo(e,t){if(e.name===`QuotaExceededError`||e.message&&e.message.includes(`reclaimed`)){console.warn(`[initiateFallback] Ignoring soft error (Context: ${t}): Codec reclaimed by browser. Waiting for tab focus to re-initialize.`);return}if(!Hn&&!window.isFallingBack&&V!==`jpeg`){Hn=!0,Un=performance.now(),console.warn(`[initiateFallback] Decoder error (Context: ${t}); retrying on software decode.`,e),qn(!0),Po();return}if(performance.now()-Un<Wn){console.warn(`[initiateFallback] Ignoring decoder error (Context: ${t}) from the decoders the software switch replaced.`);return}let n=i(V);if(!G&&H(V)&&n!==`h264`){if(Wi)return;if(na(`${n} (refused at decode)`,n),Wi){Hn=!1,qn(!1),_a();return}}if(console.error(`FATAL DECODER ERROR (Context: ${t}).`,e),!window.isFallingBack){if(window.isFallingBack=!0,qn(!1),l&&l.readyState===WebSocket.OPEN&&(l.onclose=null,l.close()),Ye&&=(clearInterval(Ye),null),G)console.log(`Shared client fallback: Reloading page to re-sync with the stream.`),q&&(q.textContent=`A video error occurred. Reloading to re-sync with the stream...`,q.classList.remove(`hidden`));else{console.log(`Primary client fallback: Forcing client settings to safe defaults.`);let e=parseInt(window.localStorage.getItem(Yn)||`0`);e++,zn(Yn,e.toString()),e>=3?(Ir(`encoder`,`jpeg`),zn(Yn,`0`)):V===`jpeg`?zn(Yn,`0`):Ir(`encoder`,`h264enc`),Pr(`video_fullcolor`,!1),Mr(`framerate`,60),Mr(`video_crf`,25),Pr(`manual_resolution`,!1),Mr(`manual_width`,null),Mr(`manual_height`,null),q&&(q.textContent=`A critical video error occurred. Resetting to default settings and reloading...`,q.classList.remove(`hidden`))}setTimeout(()=>{window.location.reload()},3e3)}}function Io(){return ga(),window.isSecureContext?(window.VideoDecoder===void 0?(console.warn(`VideoDecoder API unavailable: the stream is pinned to the jpeg encoder.`),Lo()):console.log(`Pre-flight checks passed: Secure context and VideoDecoder API are available.`),!0):(console.error(`FATAL: Not in a secure context. WebCodecs require HTTPS.`),q&&(q.textContent=`Error: This application requires a secure connection (HTTPS). Please check the URL.`,q.classList.remove(`hidden`)),kr&&kr.classList.add(`hidden`),!1)}function Lo(){V=`jpeg`,Ir(`encoder`,`jpeg`)}window.addEventListener(`beforeunload`,Ao),window.webrtcInput=null}var On=`webrtc`,kn=`websockets`,An=window.location.origin+window.location.pathname,jn=ge(),Mn=e=>`${jn}_${e}`,Nn=(e,t)=>{try{localStorage.setItem(e,t)}catch(t){console.warn(`Selkies: could not persist '${e}' to localStorage:`,t)}};(function(){try{if(typeof localStorage>`u`)return;let e=``;for(let t=0;t<An.length;t++){let n=An.charCodeAt(t);e+=n>=46&&n<=95||n>=97&&n<=122?An[t]:`_`}let t=e+`?`,n=[];for(let e=0;e<localStorage.length;e++){let r=localStorage.key(e);r&&r.startsWith(t)&&n.push(r)}if(n.forEach(e=>localStorage.removeItem(e)),n.length&&console.log(`Selkies: removed ${n.length} stale token-scoped localStorage keys.`),e===jn)return;let r=`${jn}_storage_key_migrated`;if(localStorage.getItem(r)!==null)return;let i=`${e}_`,a=`${jn}_`,o=[];for(let e=0;e<localStorage.length;e++){let t=localStorage.key(e);t!==null&&o.push(t)}let s=o.some(e=>e.startsWith(a)),c=o.filter(e=>e.startsWith(i));if(!s&&c.length>0){for(let e of c){let t=a+e.slice(i.length);if(localStorage.getItem(t)===null){let n=localStorage.getItem(e);n!==null&&Nn(t,n)}}console.log(`Migrated ${c.length} setting(s) from old storage prefix "${i}" to "${a}".`)}Nn(r,`1`)}catch(e){console.warn(`Storage key migration skipped due to error:`,e)}})();var Pn=null;function Fn(){let e=typeof window<`u`&&window.__SELKIES_STREAMING_MODE__?window.__SELKIES_STREAMING_MODE__:void 0,t=localStorage.getItem(Mn(`stream_mode`)),n=e||t||kn;return console.log(`Streaming mode determined to be: ${n}`),n}function In(e){if(e.origin!==window.location.origin)return;let t=e.data;if(t.mode!==void 0&&t.type===`mode`){if(![On,kn].includes(t.mode))return;console.log(`Switching streaming mode to: ${t.mode}`),Nn(Mn(`stream_mode`),t.mode),setTimeout(()=>{window.location.reload()},2e3)}}function G(e){switch(Nn(Mn(`stream_mode`),e),e){case On:Pn=yn(),Pn.initialize();break;case kn:Pn=Dn();break;default:throw Error(`Invalid client mode: ${e} received, aborting`)}}typeof window<`u`&&(window.addEventListener(`message`,In),window.selkiesCoreInitialize=function(){G(Fn())}),typeof window<`u`&&!window.__SELKIES_DEFER_INITIALIZATION&&window.selkiesCoreInitialize();