import React, { useCallback, useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import {
  Button,
  EmptyState,
  Loading,
  Notice,
  Price,
  palette,
  radius,
  spacing,
  typography,
} from '@plataforma/ui';
import { useSession } from '../session.js';

/**
 * EXPERIÊNCIA DO ADMINISTRADOR.
 *
 * É a terceira experiência do sistema, distinta do operador: cadastro de
 * produto, alteração de preço, categorias e chave Pix. As seções são exibidas
 * conforme as PERMISSÕES resolvidas pelo servidor em /v1/auth/me — não por um
 * papel guardado no app.
 *
 * Esconder um botão é conveniência, não segurança: quem chamar a rota sem a
 * permissão recebe 403 do servidor de qualquer forma.
 */
export function AdminScreen() {
  const { api, profile, signOut } = useSession();
  const branchId = profile?.branchScope[0] ?? null;

  const can = useCallback(
    (permission: string) => profile?.permissions.includes(permission) ?? false,
    [profile],
  );

  const [products, setProducts] = useState<Array<{ id: string; name: string; priceCents: number; isActive: boolean }> | null>(null);
  const [message, setMessage] = useState<{ tone: 'info' | 'danger'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  // Formulário de produto
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [price, setPrice] = useState('');
  const [featured, setFeatured] = useState(false);
  const [notes, setNotes] = useState('');

  // Formulário de Pix
  const [pixKey, setPixKey] = useState('');
  const [merchantName, setMerchantName] = useState('');
  const [merchantCity, setMerchantCity] = useState('');

  const load = useCallback(async () => {
    if (!branchId || !can('product:read')) return;
    try {
      setProducts((await api.listProducts(branchId)) as never);
    } catch (e) {
      setMessage({ tone: 'danger', text: (e as Error).message });
    }
  }, [api, branchId, can]);

  useEffect(() => {
    void load();
  }, [load]);

  function parsePriceToCents(input: string): number | null {
    const normalized = input.replace(/\./g, '').replace(',', '.');
    const value = Number.parseFloat(normalized);
    if (!Number.isFinite(value) || value < 0) return null;
    // Dinheiro trafega em centavos inteiros — nunca em float (ADR-0010).
    return Math.round(value * 100);
  }

  async function createProduct() {
    if (!branchId) return;
    const priceCents = parsePriceToCents(price);
    if (!name.trim() || priceCents === null) {
      setMessage({ tone: 'danger', text: 'Informe nome e preço válidos.' });
      return;
    }

    setBusy(true);
    try {
      await api.createProduct(branchId, {
        name: name.trim(),
        description: description.trim() || null,
        priceCents,
        isFeatured: featured,
        notes: notes.trim() || null,
      });
      setName('');
      setDescription('');
      setPrice('');
      setNotes('');
      setFeatured(false);
      setMessage({ tone: 'info', text: 'Produto criado.' });
      await load();
    } catch (e) {
      setMessage({ tone: 'danger', text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  async function updatePrice(productId: string, input: string) {
    if (!branchId) return;
    const priceCents = parsePriceToCents(input);
    if (priceCents === null) return;

    setBusy(true);
    try {
      await api.updateProduct(branchId, productId, { priceCents });
      setMessage({ tone: 'info', text: 'Preço atualizado. A alteração foi registrada na auditoria.' });
      await load();
    } catch (e) {
      setMessage({ tone: 'danger', text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  async function savePix() {
    if (!branchId) return;
    setBusy(true);
    try {
      const result = await api.setPixSettings(branchId, {
        keyType: pixKey.includes('@') ? 'EMAIL' : pixKey.startsWith('+') ? 'PHONE' : 'RANDOM',
        key: pixKey.trim(),
        merchantName: merchantName.trim(),
        merchantCity: merchantCity.trim(),
      });
      setPixKey('');
      setMessage({
        tone: 'info',
        text: `Chave Pix atualizada (${result.keyMasked}). O administrador da franquia foi notificado.`,
      });
    } catch (e) {
      setMessage({ tone: 'danger', text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  if (!profile) return <Loading />;
  if (!branchId) return <EmptyState title="Sem unidade associada" />;

  const isAdmin = can('product:create') || can('pix_settings:update');

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <View style={styles.card}>
        <Text style={typography.heading}>{profile.fullName}</Text>
        <Text style={typography.caption}>
          {profile.roles.join(', ')} · {profile.isOrgWide ? 'toda a organização' : `${profile.branchScope.length} unidade(s)`}
        </Text>
        <Text style={typography.caption}>{profile.permissions.length} permissões ativas</Text>
      </View>

      {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}

      {!isAdmin ? (
        <Notice tone="info">
          Seu papel não inclui administração de catálogo. Use a aba Pedidos e Estoque.
        </Notice>
      ) : null}

      {can('product:create') ? (
        <View style={styles.card}>
          <Text style={typography.heading}>Novo produto</Text>
          <TextInput
            accessibilityLabel="Nome do produto"
            placeholder="Nome"
            placeholderTextColor={palette.ink500}
            value={name}
            onChangeText={setName}
            style={styles.input}
          />
          <TextInput
            accessibilityLabel="Descrição"
            placeholder="Descrição"
            placeholderTextColor={palette.ink500}
            value={description}
            onChangeText={setDescription}
            multiline
            style={[styles.input, styles.multiline]}
          />
          <TextInput
            accessibilityLabel="Preço"
            placeholder="Preço (ex.: 29,90)"
            placeholderTextColor={palette.ink500}
            keyboardType="decimal-pad"
            value={price}
            onChangeText={setPrice}
            style={styles.input}
          />
          <TextInput
            accessibilityLabel="Observações internas"
            placeholder="Observações internas (não aparece ao cliente)"
            placeholderTextColor={palette.ink500}
            value={notes}
            onChangeText={setNotes}
            style={styles.input}
          />
          <View style={styles.switchRow}>
            <Text style={typography.body}>Destaque no cardápio</Text>
            <Switch value={featured} onValueChange={setFeatured} />
          </View>
          <Button
            label="Criar produto"
            loading={busy}
            onPress={() => void createProduct()}
          />
        </View>
      ) : null}

      {can('product:read') ? (
        <View style={styles.card}>
          <Text style={typography.heading}>Catálogo</Text>
          {products === null ? (
            <Loading />
          ) : products.length === 0 ? (
            <Text style={typography.caption}>Nenhum produto cadastrado.</Text>
          ) : (
            products.map((product) => (
              <ProductRow
                key={product.id}
                product={product}
                canEditPrice={can('price:update')}
                onSavePrice={(value) => void updatePrice(product.id, value)}
              />
            ))
          )}
        </View>
      ) : null}

      {can('pix_settings:update') ? (
        <View style={styles.card}>
          <Text style={typography.heading}>Chave Pix da unidade</Text>
          <Notice tone="warning">
            Alterar a chave Pix redireciona todo o dinheiro que entra. A mudança é registrada na
            auditoria e o administrador da franquia é notificado.
          </Notice>
          <TextInput
            accessibilityLabel="Chave Pix"
            placeholder="Chave Pix (e-mail, telefone, CPF/CNPJ ou aleatória)"
            placeholderTextColor={palette.ink500}
            autoCapitalize="none"
            value={pixKey}
            onChangeText={setPixKey}
            style={styles.input}
          />
          <TextInput
            accessibilityLabel="Nome do recebedor"
            placeholder="Nome do recebedor (máx. 25)"
            placeholderTextColor={palette.ink500}
            maxLength={25}
            value={merchantName}
            onChangeText={setMerchantName}
            style={styles.input}
          />
          <TextInput
            accessibilityLabel="Cidade do recebedor"
            placeholder="Cidade (máx. 15)"
            placeholderTextColor={palette.ink500}
            maxLength={15}
            value={merchantCity}
            onChangeText={setMerchantCity}
            style={styles.input}
          />
          <Button
            label="Salvar chave Pix"
            loading={busy}
            disabled={!pixKey.trim() || !merchantName.trim() || !merchantCity.trim()}
            onPress={() => void savePix()}
          />
        </View>
      ) : null}

      <Button label="Sair" variant="ghost" onPress={() => void signOut()} />
    </ScrollView>
  );
}

function ProductRow({
  product,
  canEditPrice,
  onSavePrice,
}: {
  product: { id: string; name: string; priceCents: number; isActive: boolean };
  canEditPrice: boolean;
  onSavePrice: (value: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(
    `${Math.floor(product.priceCents / 100)},${String(product.priceCents % 100).padStart(2, '0')}`,
  );

  return (
    <View style={styles.productRow}>
      <View style={styles.productInfo}>
        <Text style={typography.body} numberOfLines={1}>
          {product.name}
        </Text>
        {!product.isActive ? <Text style={typography.caption}>inativo</Text> : null}
      </View>

      {editing ? (
        <View style={styles.priceEdit}>
          <TextInput
            accessibilityLabel={`Novo preço de ${product.name}`}
            keyboardType="decimal-pad"
            value={value}
            onChangeText={setValue}
            style={[styles.input, styles.priceInput]}
            autoFocus
          />
          <Button
            label="OK"
            onPress={() => {
              setEditing(false);
              onSavePrice(value);
            }}
            style={styles.priceButton}
          />
        </View>
      ) : (
        <View style={styles.priceView}>
          <Price cents={product.priceCents} size="sm" />
          {canEditPrice ? (
            <Button
              label="Editar"
              variant="ghost"
              onPress={() => setEditing(true)}
              style={styles.priceButton}
            />
          ) : null}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: palette.ink100 },
  content: { padding: spacing.lg, gap: spacing.md },
  card: { backgroundColor: palette.white, borderRadius: radius.lg, padding: spacing.lg, gap: spacing.sm },
  input: {
    borderWidth: 1,
    borderColor: palette.ink300,
    borderRadius: radius.md,
    padding: spacing.md,
    minHeight: 48,
    color: palette.ink900,
  },
  multiline: { minHeight: 72, textAlignVertical: 'top' },
  switchRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: spacing.sm,
  },
  productRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: palette.ink100,
  },
  productInfo: { flex: 1 },
  priceView: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  priceEdit: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  priceInput: { minWidth: 90, minHeight: 40, paddingVertical: 0 },
  priceButton: { minHeight: 40, paddingHorizontal: spacing.md },
});
