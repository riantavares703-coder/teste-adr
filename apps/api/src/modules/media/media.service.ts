import { Inject, Injectable, Logger } from '@nestjs/common';
import { uuidv7 } from '../../common/uuid.js';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import sharp from 'sharp';
import { and, eq } from 'drizzle-orm';
import { Database } from '../../db/client.js';
import * as s from '../../db/schema.js';
import { badRequest, notFound, unprocessable } from '../../common/errors.js';
import { toTenantContext, type Principal } from '../../common/principal.js';
import { loadEnv } from '../../config/env.js';
import { AuditService } from '../audit/audit.service.js';
import { BranchAccessService } from '../tenancy/branch-access.service.js';

/**
 * Assinaturas de arquivo (magic bytes).
 * O `Content-Type` declarado pelo cliente é uma SUGESTÃO, não prova: um
 * executável renomeado para .jpg chega com content-type de imagem.
 */
const MAGIC_BYTES: Array<{ mime: string; test: (b: Buffer) => boolean }> = [
  { mime: 'image/jpeg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  {
    mime: 'image/png',
    test: (b) =>
      b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 &&
      b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a,
  },
  {
    mime: 'image/webp',
    test: (b) =>
      b.subarray(0, 4).toString('ascii') === 'RIFF' &&
      b.subarray(8, 12).toString('ascii') === 'WEBP',
  },
];

const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp']);
const MAX_DIMENSION = 4096;

export interface UploadResult {
  imageId: string;
  storageKey: string;
  thumbStorageKey: string;
  mediumStorageKey: string;
  width: number;
  height: number;
  byteSize: number;
}

/**
 * Upload de imagem de produto (item 2 do Prompt 02).
 *
 * Nove controles em série:
 *  1. permissão + escopo de unidade;
 *  2. limite de tamanho ANTES de decodificar;
 *  3. allowlist de MIME;
 *  4. verificação de MAGIC BYTES (não confia no content-type declarado);
 *  5. limite de dimensões (anti "bomba de descompressão");
 *  6. REPROCESSAMENTO com sharp — a imagem é reescrita, destruindo polyglots,
 *     payload embutido e qualquer coisa que não seja pixel;
 *  7. EXIF removido (evita vazar geolocalização do lojista);
 *  8. nome do arquivo do usuário DESCARTADO — a chave é um UUID do servidor,
 *     o que elimina path traversal por construção;
 *  9. armazenamento fora de qualquer diretório público, servido por rota
 *     própria com Content-Type fixo e nosniff.
 */
@Injectable()
export class MediaService {
  private readonly logger = new Logger('Media');
  private readonly env = loadEnv();
  private readonly root = resolve(this.env.MEDIA_STORAGE_DIR);

  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(BranchAccessService) private readonly branchAccess: BranchAccessService,
  ) {}

  async uploadProductImage(
    principal: Principal,
    branchId: string,
    productId: string,
    file: { buffer: Buffer; mimetype: string; originalname?: string },
    options: { altText?: string; isPrimary?: boolean } = {},
  ): Promise<UploadResult> {
    await this.branchAccess.assertAccess(principal, branchId);

    // 2. tamanho
    if (file.buffer.length === 0) throw badRequest('ARQUIVO_VAZIO', 'Arquivo vazio');
    if (file.buffer.length > this.env.MEDIA_MAX_BYTES) {
      throw unprocessable(
        'ARQUIVO_GRANDE',
        `Arquivo excede ${Math.floor(this.env.MEDIA_MAX_BYTES / 1024 / 1024)} MB`,
      );
    }

    // 3. allowlist de MIME declarado
    if (!ALLOWED_MIME.has(file.mimetype)) {
      throw unprocessable('TIPO_NAO_PERMITIDO', 'Envie uma imagem JPEG, PNG ou WebP');
    }

    // 4. magic bytes — a prova real do que o arquivo é
    const detected = MAGIC_BYTES.find((m) => m.test(file.buffer))?.mime;
    if (!detected) {
      throw unprocessable(
        'CONTEUDO_NAO_E_IMAGEM',
        'O conteúdo do arquivo não é uma imagem válida',
      );
    }
    if (detected !== file.mimetype) {
      throw unprocessable(
        'TIPO_DIVERGENTE',
        'O tipo declarado não corresponde ao conteúdo do arquivo',
      );
    }

    // 5. dimensões
    let metadata: sharp.Metadata;
    try {
      metadata = await sharp(file.buffer, { limitInputPixels: MAX_DIMENSION * MAX_DIMENSION }).metadata();
    } catch {
      throw unprocessable('IMAGEM_INVALIDA', 'Não foi possível ler a imagem');
    }
    if (!metadata.width || !metadata.height) {
      throw unprocessable('IMAGEM_INVALIDA', 'Imagem sem dimensões válidas');
    }
    if (metadata.width > MAX_DIMENSION || metadata.height > MAX_DIMENSION) {
      throw unprocessable('IMAGEM_GRANDE', `Máximo ${MAX_DIMENSION}x${MAX_DIMENSION} pixels`);
    }

    // 6/7. reprocessamento: a imagem é REESCRITA a partir dos pixels.
    // Qualquer conteúdo não-pixel (script em comentário, payload após o EOF,
    // arquivo polyglot) desaparece porque não é copiado — é descartado.
    const pipeline = (width: number) =>
      sharp(file.buffer)
        .rotate() // aplica a orientação EXIF antes de descartá-la
        .resize({ width, withoutEnlargement: true })
        .webp({ quality: 82 })
        .toBuffer({ resolveWithObject: true });

    const [full, medium, thumb] = await Promise.all([
      pipeline(1600),
      pipeline(800),
      pipeline(200),
    ]);

    // 8. chave é UUID do servidor; o nome enviado pelo usuário nunca é usado
    const baseKey = uuidv7();
    const storageKey = `${baseKey}.webp`;
    const mediumStorageKey = `${baseKey}_md.webp`;
    const thumbStorageKey = `${baseKey}_sm.webp`;

    await this.write(storageKey, full.data);
    await this.write(mediumStorageKey, medium.data);
    await this.write(thumbStorageKey, thumb.data);

    const imageId = uuidv7();

    await this.db.withTenant(toTenantContext(principal), async (tx) => {
      const product = await tx
        .select({ id: s.products.id, organizationId: s.products.organizationId })
        .from(s.products)
        .where(and(eq(s.products.id, productId), eq(s.products.branchId, branchId)))
        .limit(1);
      if (!product[0]) throw notFound();

      if (options.isPrimary) {
        await tx
          .update(s.productImages)
          .set({ isPrimary: false })
          .where(eq(s.productImages.productId, productId));
      }

      await tx.insert(s.productImages).values({
        id: imageId,
        productId,
        branchId,
        storageKey,
        thumbStorageKey,
        mediumStorageKey,
        contentType: 'image/webp',
        byteSize: full.data.length,
        width: full.info.width,
        height: full.info.height,
        altText: options.altText ?? null,
        isPrimary: options.isPrimary ?? false,
      } as never);

      await tx.insert(s.mediaAssets).values({
        id: uuidv7(),
        organizationId: product[0].organizationId,
        branchId,
        storageKey,
        contentType: 'image/webp',
        byteSize: full.data.length,
        checksumSha256: createHash('sha256').update(full.data).digest(),
        uploadedBy: principal.userId,
        scanStatus: 'CLEAN', // reprocessamento já neutralizou o conteúdo
        isConfirmed: true,
      } as never);

      await this.audit.record(tx, {
        principal,
        organizationId: product[0].organizationId,
        branchId,
        action: 'product_image.uploaded',
        resourceType: 'product_image',
        resourceId: imageId,
        metadata: { productId, byteSize: full.data.length, declaredMime: file.mimetype },
      });
    });

    return {
      imageId,
      storageKey,
      thumbStorageKey,
      mediumStorageKey,
      width: full.info.width,
      height: full.info.height,
      byteSize: full.data.length,
    };
  }

  /**
   * Leitura para servir a imagem.
   * A chave é validada contra um formato estrito ANTES de tocar o disco:
   * mesmo que algo passe pelo roteador, `../../etc/passwd` não é uma chave
   * válida e nunca chega ao sistema de arquivos.
   */
  async read(storageKey: string): Promise<{ buffer: Buffer; contentType: string }> {
    if (!/^[0-9a-f-]{36}(_md|_sm)?\.webp$/i.test(storageKey)) {
      throw notFound('MIDIA_NAO_ENCONTRADA', 'Mídia não encontrada');
    }
    const path = join(this.root, storageKey);
    // Defesa redundante: o caminho resolvido precisa estar dentro da raiz.
    if (!resolve(path).startsWith(this.root)) {
      throw notFound('MIDIA_NAO_ENCONTRADA', 'Mídia não encontrada');
    }
    try {
      return { buffer: await readFile(path), contentType: 'image/webp' };
    } catch {
      throw notFound('MIDIA_NAO_ENCONTRADA', 'Mídia não encontrada');
    }
  }

  /** Remoção segura: soft delete no banco + remoção das três variantes. */
  async deleteProductImage(
    principal: Principal,
    branchId: string,
    imageId: string,
  ): Promise<void> {
    await this.branchAccess.assertAccess(principal, branchId);

    const keys = await this.db.withTenant(toTenantContext(principal), async (tx) => {
      const rows = await tx
        .select()
        .from(s.productImages)
        .where(and(eq(s.productImages.id, imageId), eq(s.productImages.branchId, branchId)))
        .limit(1);
      const image = rows[0];
      if (!image) throw notFound();

      await tx
        .update(s.productImages)
        .set({ deletedAt: new Date() })
        .where(eq(s.productImages.id, imageId));

      await this.audit.record(tx, {
        principal,
        organizationId: null,
        branchId,
        action: 'product_image.deleted',
        resourceType: 'product_image',
        resourceId: imageId,
        metadata: { productId: image.productId },
      });

      return [image.storageKey, image.mediumStorageKey, image.thumbStorageKey].filter(
        (k): k is string => Boolean(k),
      );
    });

    for (const key of keys) {
      await rm(join(this.root, key), { force: true }).catch((error) =>
        this.logger.warn(`Falha ao remover ${key}: ${(error as Error).message}`),
      );
    }
  }

  private async write(key: string, data: Buffer): Promise<void> {
    const path = join(this.root, key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, data, { mode: 0o640 });
  }
}
