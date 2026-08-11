import { Controller, Delete, Get, Inject, Param, ParseUUIDPipe, Post, Query, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import { badRequest, unauthorized } from '../../common/errors.js';
import { CurrentUser, Public, RequirePermission, type Principal } from '../../common/principal.js';
import { MediaService } from './media.service.js';

interface MultipartRequest {
  body?: Record<string, unknown>;
  rawFile?: { buffer: Buffer; mimetype: string; originalname?: string };
}

@Controller('v1')
export class MediaController {
  constructor(@Inject(MediaService) private readonly media: MediaService) {}

  /**
   * Upload de foto de produto.
   *
   * O corpo chega como binário puro com `Content-Type` da imagem (o middleware
   * em main.ts monta `rawFile`). Isso evita depender de parser multipart, que é
   * uma superfície de ataque conhecida, e mantém o limite de tamanho aplicado
   * antes de qualquer decodificação.
   */
  @Post('branches/:branchId/products/:productId/images')
  @RequirePermission('media:upload')
  async upload(
    @Param('branchId', ParseUUIDPipe) branchId: string,
    @Param('productId', ParseUUIDPipe) productId: string,
    @CurrentUser() principal: Principal | null,
    @Req() req: MultipartRequest,
    @Query('primary') primary?: string,
    @Query('alt') alt?: string,
  ) {
    if (!principal) throw unauthorized();
    if (!req.rawFile) throw badRequest('ARQUIVO_AUSENTE', 'Envie o binário da imagem no corpo');

    return this.media.uploadProductImage(principal, branchId, productId, req.rawFile, {
      isPrimary: primary === 'true',
      altText: alt,
    });
  }

  /**
   * Serve a imagem.
   *
   * Público por natureza (é foto de cardápio), mas NUNCA a partir de um
   * diretório público: o arquivo é lido de um diretório privado, a chave é
   * validada contra formato estrito e o Content-Type é FIXADO no servidor com
   * `nosniff` — o navegador não pode ser induzido a interpretar como script.
   */
  @Get('media/:storageKey')
  @Public()
  async serve(@Param('storageKey') storageKey: string, @Res() res: Response) {
    const { buffer, contentType } = await this.media.read(storageKey);
    res.setHeader('Content-Type', contentType);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.setHeader('Cache-Control', 'public, max-age=86400, immutable');
    res.send(buffer);
  }

  @Delete('branches/:branchId/products/images/:imageId')
  @RequirePermission('media:upload')
  async remove(
    @Param('branchId', ParseUUIDPipe) branchId: string,
    @Param('imageId', ParseUUIDPipe) imageId: string,
    @CurrentUser() principal: Principal | null,
  ) {
    if (!principal) throw unauthorized();
    await this.media.deleteProductImage(principal, branchId, imageId);
    return { deleted: true };
  }
}
