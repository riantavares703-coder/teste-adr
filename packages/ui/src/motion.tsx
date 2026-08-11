import React, { useEffect, useRef } from 'react';
import {
  AccessibilityInfo,
  Animated,
  Easing,
  Pressable,
  View,
  type AccessibilityRole,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

/**
 * MICROINTERAÇÕES (item "animações discretas").
 *
 * Duas regras que valem para tudo aqui:
 *
 *  1. `useNativeDriver: true` sempre. Animação de opacidade e transformação
 *     roda na thread de UI; sem isso, a animação engasga exatamente quando a
 *     lista está carregando — que é quando ela é mais vista.
 *  2. RESPEITAR "reduzir movimento". Quem ligou essa opção no sistema tem
 *     motivo (enxaqueca vestibular, sensibilidade a movimento). Ignorar
 *     acessibilidade é o oposto de produto profissional, então as animações
 *     degradam para o estado final imediato, sem quebrar layout.
 */

function useReduceMotion(): boolean {
  const [reduce, setReduce] = React.useState(false);
  useEffect(() => {
    let alive = true;
    AccessibilityInfo.isReduceMotionEnabled()
      .then((value) => alive && setReduce(value))
      .catch(() => undefined);
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduce);
    return () => {
      alive = false;
      sub.remove();
    };
  }, []);
  return reduce;
}

/**
 * Área tocável que "afunda" levemente ao toque.
 *
 * É o feedback visual pedido no item 11: o usuário precisa saber que o toque
 * foi registrado antes de a rede responder.
 */
export function Touchable({
  onPress,
  onLongPress,
  disabled,
  children,
  style,
  scaleTo = 0.97,
  accessibilityRole = 'button',
  accessibilityLabel,
  accessibilityHint,
  accessibilityState,
  testID,
}: {
  onPress?: () => void;
  onLongPress?: () => void;
  disabled?: boolean;
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  scaleTo?: number;
  accessibilityRole?: AccessibilityRole;
  accessibilityLabel?: string;
  accessibilityHint?: string;
  accessibilityState?: { disabled?: boolean; selected?: boolean; busy?: boolean };
  testID?: string;
}) {
  const scale = useRef(new Animated.Value(1)).current;
  const reduceMotion = useReduceMotion();

  const animate = (to: number) => {
    if (reduceMotion) return;
    Animated.spring(scale, {
      toValue: to,
      useNativeDriver: true,
      speed: 40,
      bounciness: 4,
    }).start();
  };

  return (
    <Pressable
      testID={testID}
      accessibilityRole={accessibilityRole}
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: Boolean(disabled), ...accessibilityState }}
      disabled={disabled}
      onPress={onPress}
      onLongPress={onLongPress}
      onPressIn={() => animate(scaleTo)}
      onPressOut={() => animate(1)}
      style={style}
    >
      <Animated.View style={{ transform: [{ scale }] }}>{children}</Animated.View>
    </Pressable>
  );
}

/** Entrada suave: usada quando conteúdo real substitui o esqueleto. */
export function FadeIn({
  children,
  delay = 0,
  offset = 8,
  style,
}: {
  children: React.ReactNode;
  delay?: number;
  offset?: number;
  style?: StyleProp<ViewStyle>;
}) {
  const progress = useRef(new Animated.Value(0)).current;
  const reduceMotion = useReduceMotion();

  useEffect(() => {
    if (reduceMotion) {
      progress.setValue(1);
      return;
    }
    Animated.timing(progress, {
      toValue: 1,
      duration: 260,
      delay,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, [delay, progress, reduceMotion]);

  return (
    <Animated.View
      style={[
        style,
        {
          opacity: progress,
          transform: [
            { translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [offset, 0] }) },
          ],
        },
      ]}
    >
      {children}
    </Animated.View>
  );
}

/** Pulsação do esqueleto de carregamento. */
export function Pulse({ children, style }: { children?: React.ReactNode; style?: StyleProp<ViewStyle> }) {
  const progress = useRef(new Animated.Value(0.4)).current;
  const reduceMotion = useReduceMotion();

  useEffect(() => {
    if (reduceMotion) {
      progress.setValue(0.7);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(progress, {
          toValue: 1,
          duration: 700,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
        Animated.timing(progress, {
          toValue: 0.4,
          duration: 700,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [progress, reduceMotion]);

  return <Animated.View style={[style, { opacity: progress }]}>{children}</Animated.View>;
}

/** Barra de progresso animada — usada na linha do tempo do pedido. */
export function ProgressBar({
  value,
  color,
  trackColor,
  height = 6,
}: {
  value: number;
  color: string;
  trackColor: string;
  height?: number;
}) {
  const progress = useRef(new Animated.Value(0)).current;
  const reduceMotion = useReduceMotion();
  const clamped = Math.max(0, Math.min(1, value));

  useEffect(() => {
    if (reduceMotion) {
      progress.setValue(clamped);
      return;
    }
    Animated.timing(progress, {
      toValue: clamped,
      duration: 420,
      easing: Easing.out(Easing.cubic),
      // Largura não é animável pelo driver nativo; a barra é curta e o custo
      // na thread de JS é irrelevante aqui.
      useNativeDriver: false,
    }).start();
  }, [clamped, progress, reduceMotion]);

  return (
    <View
      accessibilityRole="progressbar"
      accessibilityValue={{ now: Math.round(clamped * 100), min: 0, max: 100 }}
      style={{ height, borderRadius: height, backgroundColor: trackColor, overflow: 'hidden' }}
    >
      <Animated.View
        style={{
          height,
          borderRadius: height,
          backgroundColor: color,
          width: progress.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] }),
        }}
      />
    </View>
  );
}
