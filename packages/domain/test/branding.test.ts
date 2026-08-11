import { describe, expect, it } from 'vitest';
import {
  BRAND_FONTS,
  CONTRAST_AA_TEXT,
  DEFAULT_BRANDING,
  GUARANTEED_MIN_CONTRAST,
  bestTextOn,
  contrastRatio,
  fontFamilyOf,
  gradientGeometry,
  mix,
  normalizeHex,
  relativeLuminance,
  resolveTheme,
  validateBranding,
  withAlpha,
} from '../src/branding.js';

describe('normalização de cor', () => {
  it('aceita apenas #RRGGBB e normaliza para minúsculas', () => {
    expect(normalizeHex('#FF5A00')).toBe('#ff5a00');
    expect(normalizeHex('  #ff5a00  ')).toBe('#ff5a00');
  });

  it('recusa formatos que não são exatamente uma cor', () => {
    // Cada um destes é uma tentativa plausível de sair do campo "cor".
    for (const attempt of [
      '#fff', // curto: seria válido em CSS, não aqui
      'red',
      'rgb(255,0,0)',
      '#ff5a00; background: url(javascript:alert(1))',
      '#ff5a00\n#000000',
      'var(--x)',
      '#gggggg',
      '#ff5a0',
      '#ff5a000',
      '',
      null,
      undefined,
      42,
      {},
    ]) {
      expect(normalizeHex(attempt as unknown), `deveria recusar ${String(attempt)}`).toBeNull();
    }
  });
});

describe('contraste (WCAG 2.1)', () => {
  it('preto sobre branco é 21:1', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
  });

  it('cores idênticas são 1:1', () => {
    expect(contrastRatio('#e11d48', '#e11d48')).toBeCloseTo(1, 10);
  });

  it('é simétrico', () => {
    expect(contrastRatio('#123456', '#fedcba')).toBeCloseTo(contrastRatio('#fedcba', '#123456'), 10);
  });

  it('reproduz a luminância de referência do branco e do preto', () => {
    expect(relativeLuminance('#ffffff')).toBeCloseTo(1, 10);
    expect(relativeLuminance('#000000')).toBeCloseTo(0, 10);
  });

  it('escolhe texto claro em fundo escuro e escuro em fundo claro', () => {
    expect(bestTextOn('#0f172a')).toBe('#ffffff');
    expect(bestTextOn('#fbbf24')).toBe('#000000');
    expect(bestTextOn('#ffffff')).toBe('#000000');
  });

  it('o texto derivado atinge AA para QUALQUER cor de marca', () => {
    // Varredura densa pelo espaço de cor. Nenhuma cor que o lojista consiga
    // escolher pode produzir um botão ilegível, porque a cor do texto não é
    // configurável — é derivada.
    let worst = { hex: '', ratio: Infinity };
    for (let r = 0; r < 256; r += 17) {
      for (let g = 0; g < 256; g += 17) {
        for (let b = 0; b < 256; b += 17) {
          const hex = `#${[r, g, b].map((n) => n.toString(16).padStart(2, '0')).join('')}`;
          const ratio = contrastRatio(hex, bestTextOn(hex));
          if (ratio < worst.ratio) worst = { hex, ratio };
        }
      }
    }
    expect(worst.ratio, `pior cor: ${worst.hex}`).toBeGreaterThanOrEqual(CONTRAST_AA_TEXT);
    // E o pior caso empírico bate com o piso teórico: a garantia é estrutural,
    // não coincidência da amostragem.
    expect(worst.ratio).toBeGreaterThanOrEqual(GUARANTEED_MIN_CONTRAST - 1e-9);
    expect(GUARANTEED_MIN_CONTRAST).toBeGreaterThan(CONTRAST_AA_TEXT);
  });

  it('afrouxar o extremo escuro quebraria a garantia', () => {
    // Documenta por que os candidatos são preto e branco PUROS: com #111111,
    // este azul de meio tom reprova contra os dois lados.
    const midBlue = '#6666ff';
    expect(contrastRatio(midBlue, '#111111')).toBeLessThan(CONTRAST_AA_TEXT);
    expect(contrastRatio(midBlue, '#ffffff')).toBeLessThan(CONTRAST_AA_TEXT);
    expect(contrastRatio(midBlue, bestTextOn(midBlue))).toBeGreaterThanOrEqual(CONTRAST_AA_TEXT);
  });
});

describe('fontes', () => {
  it('só resolve famílias da lista fechada', () => {
    expect(fontFamilyOf('POPPINS')).toBe('Poppins');
    expect(fontFamilyOf('DM_SANS')).toBe('DMSans');
  });

  it('token desconhecido cai na fonte do sistema, nunca no valor recebido', () => {
    expect(fontFamilyOf('Comic Sans')).toBeUndefined();
    expect(fontFamilyOf('"><script>alert(1)</script>')).toBeUndefined();
    expect(fontFamilyOf(null)).toBeUndefined();
  });

  it('a lista cobre as seis fontes pedidas no briefing', () => {
    const labels = BRAND_FONTS.map((f) => f.label);
    expect(labels).toEqual(['Inter', 'Poppins', 'Montserrat', 'Roboto', 'Nunito', 'DM Sans']);
  });
});

describe('validação de branding', () => {
  const base = {
    primaryColor: '#ff5a00',
    secondaryColor: '#1f2937',
    accentColor: '#ffb000',
    textColor: '#111827',
    backgroundColor: '#ffffff',
    cardColor: '#f9fafb',
    fontToken: 'POPPINS',
    gradientStyle: 'DIAGONAL',
    gradientFrom: '#ff5a00',
    gradientTo: '#ffb000',
  };

  it('aceita uma configuração completa e coerente', () => {
    const result = validateBranding(base);
    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([]);
    expect(result.value.primaryColor).toBe('#ff5a00');
    expect(result.value.fontToken).toBe('POPPINS');
  });

  it('recusa fonte fora da lista', () => {
    const result = validateBranding({ ...base, fontToken: 'Comic Sans MS' });
    expect(result.ok).toBe(false);
    expect(result.issues.map((i) => i.code)).toContain('FONTE_NAO_PERMITIDA');
    // Mesmo recusando, o valor normalizado é seguro.
    expect(result.value.fontToken).toBe(DEFAULT_BRANDING.fontToken);
  });

  it('recusa tentativa de injeção pelo campo de cor', () => {
    const result = validateBranding({
      ...base,
      primaryColor: '#fff; } body { background: url(https://evil.example/x) } .x {',
    });
    expect(result.ok).toBe(false);
    expect(result.issues.map((i) => i.code)).toContain('COR_INVALIDA');
    expect(result.value.primaryColor).toBe(DEFAULT_BRANDING.primaryColor);
  });

  it('recusa estilo de gradiente inventado', () => {
    const result = validateBranding({ ...base, gradientStyle: 'CONIC_45DEG' });
    expect(result.ok).toBe(false);
    expect(result.issues.map((i) => i.code)).toContain('GRADIENTE_NAO_PERMITIDO');
  });

  it('recusa texto sem contraste suficiente sobre o fundo', () => {
    const result = validateBranding({ ...base, textColor: '#eeeeee', backgroundColor: '#ffffff' });
    expect(result.ok).toBe(false);
    const issue = result.issues.find((i) => i.code === 'CONTRASTE_INSUFICIENTE');
    expect(issue?.field).toBe('textColor');
    expect(issue?.message).toMatch(/mínimo 4.5:1/);
  });

  it('recusa cor principal que some no fundo', () => {
    const result = validateBranding({ ...base, primaryColor: '#fefefe', backgroundColor: '#ffffff' });
    expect(result.issues.map((i) => i.code)).toContain('CONTRASTE_INSUFICIENTE');
  });

  it('recusa card idêntico ao fundo', () => {
    const result = validateBranding({ ...base, cardColor: '#ffffff', backgroundColor: '#ffffff' });
    expect(result.issues.map((i) => i.code)).toContain('CARD_IGUAL_AO_FUNDO');
  });

  it('recusa caracteres invisíveis no nome do estabelecimento', () => {
    const result = validateBranding({ ...base, displayName: 'Loja‮oãçatpecA' });
    expect(result.ok).toBe(false);
    expect(result.issues.map((i) => i.code)).toContain('CARACTERE_NAO_PERMITIDO');
  });

  it('recusa nome longo demais e mantém o padrão', () => {
    const result = validateBranding({ ...base, displayName: 'x'.repeat(200) });
    expect(result.issues.map((i) => i.code)).toContain('TEXTO_LONGO');
    expect(result.value.displayName).toBeNull();
  });

  it('campos ausentes caem no padrão sem gerar erro', () => {
    const result = validateBranding({});
    expect(result.ok).toBe(true);
    expect(result.value).toEqual(DEFAULT_BRANDING);
  });

  it('o branding padrão é válido segundo as próprias regras', () => {
    // Se o padrão da plataforma reprovasse na validação, todo lojista sem
    // configuração começaria com um app "inválido".
    expect(validateBranding(DEFAULT_BRANDING).ok).toBe(true);
  });
});

describe('tema resolvido', () => {
  it('deriva o texto do botão a partir da cor primária', () => {
    expect(resolveTheme({ primaryColor: '#111827' }).onPrimary).toBe('#ffffff');
    expect(resolveTheme({ primaryColor: '#fde047' }).onPrimary).toBe('#000000');
  });

  it('gradiente desligado vira duas paradas iguais', () => {
    const theme = resolveTheme({ primaryColor: '#ff5a00', gradientStyle: 'NONE' });
    expect(theme.gradient.enabled).toBe(false);
    expect(theme.gradient.colors).toEqual(['#ff5a00', '#ff5a00']);
  });

  it('gradiente ligado usa as cores configuradas e a geometria do estilo', () => {
    const theme = resolveTheme({
      gradientStyle: 'HORIZONTAL',
      gradientFrom: '#ff5a00',
      gradientTo: '#ffb000',
    });
    expect(theme.gradient.colors).toEqual(['#ff5a00', '#ffb000']);
    expect(theme.gradient.start).toEqual(gradientGeometry('HORIZONTAL').start);
  });

  it('nunca lança para entrada hostil — cai no padrão', () => {
    const theme = resolveTheme({
      primaryColor: '</style><script>alert(1)</script>',
      fontToken: '../../etc/passwd',
      gradientStyle: 42 as unknown as string,
    });
    expect(theme.primary).toBe(DEFAULT_BRANDING.primaryColor);
    expect(theme.fontFamily).toBe('Inter');
    expect(theme.gradient.style).toBe(DEFAULT_BRANDING.gradientStyle);
  });

  it('entrada nula produz o tema padrão completo', () => {
    const theme = resolveTheme(null);
    expect(theme.primary).toBe(DEFAULT_BRANDING.primaryColor);
    expect(theme.background).toBe(DEFAULT_BRANDING.backgroundColor);
  });
});

describe('utilitários de cor', () => {
  it('mistura nos extremos devolve as pontas', () => {
    expect(mix('#000000', '#ffffff', 0)).toBe('#000000');
    expect(mix('#000000', '#ffffff', 1)).toBe('#ffffff');
    expect(mix('#000000', '#ffffff', 0.5)).toBe('#808080');
  });

  it('alfa gera oito dígitos', () => {
    expect(withAlpha('#ff5a00', 1)).toBe('#ff5a00ff');
    expect(withAlpha('#ff5a00', 0)).toBe('#ff5a0000');
    expect(withAlpha('#ff5a00', 0.55)).toMatch(/^#ff5a00[0-9a-f]{2}$/);
  });
});
