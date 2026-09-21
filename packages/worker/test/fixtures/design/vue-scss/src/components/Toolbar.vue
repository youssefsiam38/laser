<script>
export default {
  props: {
    title: { type: String, required: true },
    compact: { type: Boolean, default: false }
  }
};
</script>

<template>
  <header class="panel">{{ title }}</header>
</template>
