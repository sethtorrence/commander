import { describe, expect, it } from 'vitest';
import { teamsText } from './html';

// Teams message bodies arrive as HTML. Commander keeps them as plain text with light structure
// (paragraphs, lists, links, @mentions), never as markup: Chat text is untrusted Source content.

describe('converting Teams HTML to plain text', () => {
  it('keeps paragraphs and line breaks, and decodes entities', () => {
    expect(
      teamsText('<p>Morning all &amp; welcome</p><p>Line one<br>Line two</p><div>Fish &lt;3 chips</div>'),
    ).toBe('Morning all & welcome\n\nLine one\nLine two\n\nFish <3 chips');
  });

  it('shows @mentions as @Name', () => {
    expect(teamsText('<p><at id="0">Priya Patel</at> can you look at this?</p>')).toBe(
      '@Priya Patel can you look at this?',
    );
  });

  it('keeps links, with the address when the text is something else', () => {
    expect(
      teamsText(
        '<p>See <a href="https://contoso.test/spec" title="spec">the spec</a> and <a href="https://contoso.test/">https://contoso.test/</a></p>',
      ),
    ).toBe('See the spec (https://contoso.test/spec) and https://contoso.test/');
  });

  it('keeps bulleted and numbered lists', () => {
    expect(
      teamsText(
        '<p>Today:</p><ul><li>Ship the fix</li><li>Write it up</li></ul><ol><li>First</li><li>Second</li></ol>',
      ),
    ).toBe('Today:\n\n- Ship the fix\n- Write it up\n\n1. First\n2. Second');
  });

  it('shows inline images as [image]', () => {
    expect(
      teamsText(
        '<p>Look<img src="https://graph.microsoft.com/v1.0/chats/19:x/messages/1/hostedContents/aaa/$value" alt="image" itemtype="http://schema.skype.com/AMSImage"></p>',
      ),
    ).toBe('Look [image]');
  });

  it('drops scripts, styles and hidden markup, and never keeps a tag', () => {
    const text = teamsText(
      '<style>p { color: red }</style><p onclick="steal()">Hi<script>alert("x")</script> there</p><attachment id="1700000000000"></attachment><iframe src="https://evil.test"></iframe>',
    );
    expect(text).toBe('Hi there');
    expect(text).not.toMatch(/[<>]/);
  });

  it('shows emoji by their alt text and collapses runs of whitespace', () => {
    expect(
      teamsText('<p>Nice   work\n  <emoji id="1f44d_thumbsup" alt="👍" title="Thumbs up"></emoji></p>'),
    ).toBe('Nice work 👍');
  });

  it('decodes numeric entities and non-breaking spaces', () => {
    expect(teamsText('<p>Caf&#233;&nbsp;at&#x20;noon</p>')).toBe('Café at noon');
  });

  it('keeps plain text bodies as they are, trimmed', () => {
    expect(teamsText('  plain <b>text</b>  ', 'text')).toBe('plain <b>text</b>');
  });
});
