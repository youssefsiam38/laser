<script setup lang="ts">
defineProps<{
  /** The card's heading. */
  title: string;
  subtitle?: string;
  /** How dense the card is. */
  density?: "comfortable" | "compact";
  dismissible?: boolean;
}>();
</script>

<template>
  <section class="panel">
    <h2 class="panel__heading">{{ title }}</h2>
    <p v-if="subtitle">{{ subtitle }}</p>
  </section>
</template>
