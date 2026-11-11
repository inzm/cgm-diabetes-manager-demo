import { describe, it, expect } from 'vitest';
import {
  estimateCarbsWithGemini,
  estimateCarbsLocally,
  isGeminiBffEnabled,
} from '../gemini';
import { escapeHtml } from '../utils';

describe('gemini (方式1: BFFプロキシ連携 & 日本食品標準成分表内蔵辞書)', () => {
  it('デフォルト環境ではBFFフラグがfalseまたはbooleanであること', () => {
    expect(typeof isGeminiBffEnabled()).toBe('boolean');
  });

  describe('estimateCarbsWithGemini / estimateCarbsLocally (標準食品辞書推定)', () => {
    it('白ごはん1杯に対して55.2gを推定すること', async () => {
      const res = await estimateCarbsWithGemini('白ごはん', 1, '杯');
      expect(res.carbs_g).toBe(55.2);
      expect(res.confidence).toBe('high');
      expect(res.note).toContain('精白米ご飯');
    });

    it('食パン1枚に対して26.6gを推定すること', async () => {
      const res = await estimateCarbsWithGemini('食パン', 1, '枚');
      expect(res.carbs_g).toBe(26.6);
      expect(res.note).toContain('食パン');
    });

    it('カレーライス1人前に対して85.0gを推定すること', () => {
      const res = estimateCarbsLocally('カレーライス', 1, '人前');
      expect(res.carbs_g).toBe(85.0);
    });

    it('豚汁1杯に対して4.5gを推定すること', () => {
      const res = estimateCarbsLocally('豚汁', 1, '杯');
      expect(res.carbs_g).toBe(4.5);
    });

    it('鶏むね肉などの低糖質食品に対して0.5gを推定すること', async () => {
      const res = await estimateCarbsWithGemini('鶏むね肉', 1, '枚');
      expect(res.carbs_g).toBe(0.5);
      expect(res.note).toContain('精肉');
    });

    it('未知の食品に対してデフォルト値15gを安全に返すこと', async () => {
      const res = await estimateCarbsWithGemini('不思議な未知の料理', 1, '個');
      expect(res.carbs_g).toBe(15);
      expect(res.confidence).toBe('medium');
    });

    it('「焼きそば」が「そば(48.0g)」に吸われず中華麺(65.0g)として推定されること', () => {
      const yakisoba = estimateCarbsLocally('焼きそば', 1, '人前');
      expect(yakisoba.carbs_g).toBe(65.0);
      expect(yakisoba.note).toContain('焼きそば');

      const soba = estimateCarbsLocally('ざるそば', 1, '人前');
      expect(soba.carbs_g).toBe(48.0);
    });

    it('部分一致の優先順位バグ（肉まん・豚まん・水ようかん・水飴・カレーパン・いちご大福・アイスコーヒー・お茶漬け・サンド・バーガー・パイナップル）が解消されていること', () => {
      expect(estimateCarbsLocally('肉まん', 1, '個').carbs_g).toBe(35.0);
      expect(estimateCarbsLocally('豚まん', 1, '個').carbs_g).toBe(35.0);
      expect(estimateCarbsLocally('水ようかん', 1, '個').carbs_g).toBe(35.0);
      expect(estimateCarbsLocally('水飴', 1, '大さじ').carbs_g).toBe(17.0);
      expect(estimateCarbsLocally('カレーパン', 1, '個').carbs_g).toBe(26.6);
      expect(estimateCarbsLocally('いちご大福', 1, '個').carbs_g).toBe(35.0);
      expect(estimateCarbsLocally('水', 1, '杯').carbs_g).toBe(0.0);
      expect(estimateCarbsLocally('アイスコーヒー', 1, '杯').carbs_g).toBe(0.0);
      expect(estimateCarbsLocally('アイスティー', 1, '杯').carbs_g).toBe(0.0);
      expect(estimateCarbsLocally('アイス緑茶', 1, '杯').carbs_g).toBe(0.0);
      expect(estimateCarbsLocally('お茶漬け', 1, '杯').carbs_g).toBe(55.2);
      expect(estimateCarbsLocally('鮭茶漬け', 1, '杯').carbs_g).toBe(55.2);
      expect(estimateCarbsLocally('たまごサンド', 1, '人前').carbs_g).toBe(26.6);
      expect(estimateCarbsLocally('ハムサンド', 1, '人前').carbs_g).toBe(26.6);
      expect(estimateCarbsLocally('チーズバーガー', 1, '個').carbs_g).toBe(26.6);
      expect(estimateCarbsLocally('パイナップル', 1, '皿').carbs_g).toBe(11.0);
      expect(estimateCarbsLocally('フライドポテト', 1, '人前').carbs_g).toBe(22.0);
    });

    it('INITIAL_FOODS（初期登録食品）と一致する料理がマスタ定義値・単位通りに推定されること', () => {
      expect(estimateCarbsLocally('オレンジジュース(100%)', 1, '杯').carbs_g).toBe(21.0);
      expect(estimateCarbsLocally('オレンジジュース', 1, '杯').carbs_g).toBe(21.0);
      expect(estimateCarbsLocally('野菜・果実ミックスジュース', 1, '本').carbs_g).toBe(15.4);
      expect(estimateCarbsLocally('コーンスープ', 1, '杯').carbs_g).toBe(12.5);
      expect(estimateCarbsLocally('サバの味噌煮', 1, '切れ').carbs_g).toBe(11.2);
      expect(estimateCarbsLocally('豚肉の生姜焼き', 1, '人前').carbs_g).toBe(6.5);
      expect(estimateCarbsLocally('ロールパン(2個)', 2, '個(60g)').carbs_g).toBe(28.0);
      expect(estimateCarbsLocally('ロールパン', 1, '個').carbs_g).toBe(14.0);
      expect(estimateCarbsLocally('握り寿司', 5, '貫').carbs_g).toBe(39.0);
      expect(estimateCarbsLocally('焼き餃子', 3, '個').carbs_g).toBe(14.0);
      expect(estimateCarbsLocally('鶏の唐揚げ', 2, '個').carbs_g).toBe(4.4);
    });
  });

  describe('escapeHtml (ECharts tooltip XSSサニタイズ)', () => {
    it('HTML特殊文字（&, <, >, ", \'）を完全にエスケープすること', () => {
      const malicious = `<img src=x onerror="alert('XSS')">&`;
      const escaped = escapeHtml(malicious);
      expect(escaped).toBe('&lt;img src=x onerror=&quot;alert(&#39;XSS&#39;)&quot;&gt;&amp;');
      expect(escaped).not.toContain('<');
      expect(escaped).not.toContain('>');
    });

    it('nullやundefinedに対して空文字を返すこと', () => {
      expect(escapeHtml(null)).toBe('');
      expect(escapeHtml(undefined)).toBe('');
    });
  });
});
