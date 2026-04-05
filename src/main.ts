import './style.css'
import { mount } from 'svelte'
import App from './App.svelte'

const target = document.querySelector<HTMLDivElement>('#app')
if (!target) throw new Error('Missing #app')

mount(App, { target })
