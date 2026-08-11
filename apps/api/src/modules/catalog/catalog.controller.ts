import { Body, Controller, Delete, Get, Inject, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { unauthorized } from '../../common/errors.js';
import { CurrentUser, Public, RequirePermission, type Principal } from '../../common/principal.js';
import { ZodValidationPipe } from '../../common/http.js';
import { CatalogService } from './catalog.service.js';

const ProductSchema = z
  .object({
    name: z.string().min(1).max(120),
    description: z.string().max(2000).nullable().optional(),
    categoryId: z.string().uuid().nullable().optional(),
    priceCents: z.number().int().min(0).max(100_000_000),
    sku: z.string().max(60).nullable().optional(),
    position: z.number().int().min(0).max(32_000).optional(),
    isActive: z.boolean().optional(),
    isFeatured: z.boolean().optional(),
    notes: z.string().max(1000).nullable().optional(),
    allowsCustomerNotes: z.boolean().optional(),
    preparationTimeMinutes: z.number().int().min(0).max(480).nullable().optional(),
  })
  .strict();

const CategorySchema = z
  .object({
    name: z.string().min(1).max(80),
    description: z.string().max(500).optional(),
    position: z.number().int().min(0).max(32_000).optional(),
  })
  .strict();

@Controller('v1')
export class CatalogController {
  constructor(@Inject(CatalogService) private readonly catalog: CatalogService) {}

  // --- vitrine pública -------------------------------------------------------

  @Get('public/:organizationSlug/branches')
  @Public()
  async branches(@Param('organizationSlug') organizationSlug: string) {
    return this.catalog.listPublicBranches(organizationSlug);
  }

  @Get('public/:organizationSlug/:branchSlug/menu')
  @Public()
  async menu(
    @Param('organizationSlug') organizationSlug: string,
    @Param('branchSlug') branchSlug: string,
  ) {
    return this.catalog.getPublicMenu(branchSlug, organizationSlug);
  }

  @Get('public/products/:id')
  @Public()
  async productDetail(@Param('id', ParseUUIDPipe) id: string) {
    return this.catalog.getProductDetail(id);
  }

  // --- gestão ----------------------------------------------------------------

  @Get('branches/:branchId/categories')
  @RequirePermission('product:read')
  async listCategories(
    @Param('branchId', ParseUUIDPipe) branchId: string,
    @CurrentUser() principal: Principal | null,
  ) {
    if (!principal) throw unauthorized();
    return this.catalog.listCategories(principal, branchId);
  }

  @Post('branches/:branchId/categories')
  @RequirePermission('category:manage')
  async createCategory(
    @Param('branchId', ParseUUIDPipe) branchId: string,
    @Body(new ZodValidationPipe(CategorySchema)) body: z.infer<typeof CategorySchema>,
    @CurrentUser() principal: Principal | null,
  ) {
    if (!principal) throw unauthorized();
    return this.catalog.createCategory(principal, branchId, body);
  }

  @Get('branches/:branchId/products')
  @RequirePermission('product:read')
  async listProducts(
    @Param('branchId', ParseUUIDPipe) branchId: string,
    @CurrentUser() principal: Principal | null,
  ) {
    if (!principal) throw unauthorized();
    return this.catalog.listProducts(principal, branchId);
  }

  @Post('branches/:branchId/products')
  @RequirePermission('product:create')
  async createProduct(
    @Param('branchId', ParseUUIDPipe) branchId: string,
    @Body(new ZodValidationPipe(ProductSchema)) body: z.infer<typeof ProductSchema>,
    @CurrentUser() principal: Principal | null,
  ) {
    if (!principal) throw unauthorized();
    return this.catalog.createProduct(principal, branchId, body as never);
  }

  /**
   * Alterar produto exige `product:update`; alterar PREÇO exige adicionalmente
   * `price:update`, conferido no serviço. É por isso que o OPERATOR consegue
   * marcar esgotado mas não consegue mudar o preço.
   */
  @Patch('branches/:branchId/products/:id')
  @RequirePermission('product:update')
  async updateProduct(
    @Param('branchId', ParseUUIDPipe) branchId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(ProductSchema.partial())) body: Partial<z.infer<typeof ProductSchema>>,
    @CurrentUser() principal: Principal | null,
  ) {
    if (!principal) throw unauthorized();
    return this.catalog.updateProduct(principal, branchId, id, body as never);
  }

  @Delete('branches/:branchId/products/:id')
  @RequirePermission('product:delete')
  async deleteProduct(
    @Param('branchId', ParseUUIDPipe) branchId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() principal: Principal | null,
  ) {
    if (!principal) throw unauthorized();
    await this.catalog.deleteProduct(principal, branchId, id);
    return { deleted: true };
  }
}
