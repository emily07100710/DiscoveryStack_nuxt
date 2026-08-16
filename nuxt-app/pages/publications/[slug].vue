<!-- Quiet Intelligence: a real document route, prefixed by Nuxt I18n and fully SSR rendered. -->
<script setup lang="ts">
const page = await useContentPage()
</script>
<template><ContentPage :page="page" /></template>
