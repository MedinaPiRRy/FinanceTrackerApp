import { describe, it, expect } from 'vitest'
import { defaultGroup, groupOf } from '../src/core/groups'

describe('category groups', () => {
  it('puts both people\'s differently named categories into the same household group', () => {
    expect(defaultGroup('Fast Food & Dining')).toBe('Dining')
    expect(defaultGroup('Dining & Takeout')).toBe('Dining')
    expect(defaultGroup('Groceries & Convenience')).toBe('Groceries')
    expect(defaultGroup('Groceries & Household')).toBe('Groceries')
    expect(defaultGroup('Snacks & Energy Drinks')).toBe('Groceries')
    expect(defaultGroup('Gas & Transportation')).toBe('Transportation')
    expect(defaultGroup('Subscriptions & Online')).toBe('Subscriptions')
    expect(defaultGroup('Subscriptions')).toBe('Subscriptions')
    expect(defaultGroup('Health & Personal Care')).toBe('Health & personal care')
    expect(defaultGroup('Beauty & Personal Care')).toBe('Health & personal care')
    expect(defaultGroup('Health, Therapy & Dental')).toBe('Health & personal care')
    expect(defaultGroup('Bank Fees & Interest')).toBe('Bank fees & interest')
    expect(defaultGroup('Wedding')).toBe('Wedding')
    expect(defaultGroup('Gym & Fitness')).toBe('Gym & fitness')
  })
  it('keeps unknown categories as their own group', () => {
    expect(defaultGroup('Pets')).toBe('Pets')
    expect(defaultGroup('  Gifts ')).toBe('Gifts')
  })
  it('a chosen group wins over the guess', () => {
    expect(groupOf({ name: 'Fast Food & Dining', groupName: 'Eating out' })).toBe('Eating out')
    expect(groupOf({ name: 'Fast Food & Dining', groupName: '  ' })).toBe('Dining')
    expect(groupOf({ name: 'Pets', groupName: null })).toBe('Pets')
  })
})
